"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{GLShadow}=require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js"),
 {GLWebGPUExecutor}=require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"),{createFakeHost}=require("./gl_fake_gpu.js"),
 {GLStream,GL}=require("./gl_stream_builder.js"),P=require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"),caps=require("../../src/browser/glbridge/gl-webgpu/gl_caps.js"),
 parameters=require("../../src/browser/glbridge/gl-webgpu/gl_texture_parameters.js"),reference=require("./gl_conformance/rectangle_reference.json");
for (const file of ["gl_shadow_state","gl_shadow_raster","gl_shadow_objects","gl_shadow_images","gl_shadow_textures"])require("../../src/browser/glbridge/gl-webgpu/"+file+".js");
const target=GL.TEXTURE_RECTANGLE,scene=()=>new GLStream().makeCurrent(1,0,0,16,16,1,1),
 expected=[GL.INVALID_ENUM,GL.INVALID_ENUM,GL.INVALID_ENUM,GL.INVALID_ENUM,GL.INVALID_VALUE,GL.INVALID_VALUE,GL.INVALID_VALUE,GL.INVALID_ENUM,GL.INVALID_ENUM,
  GL.INVALID_VALUE,GL.INVALID_VALUE,GL.INVALID_VALUE,GL.INVALID_ENUM,GL.INVALID_VALUE,GL.INVALID_VALUE,GL.INVALID_OPERATION];
(async()=>{
 for (const copied of [false,true]){
  const cpu=new GLShadow(),{host}=createFakeHost(),gpu=new GLWebGPUExecutor(null,{host,strict:true});await gpu.initialize();cpu.setCapabilities(gpu.capabilities());
  const send=stream=>{const bytes=stream.bytes();for (const segment of cpu.process(bytes)||[{offset:0,length:bytes.length}]){const part=segment.bytes||bytes.subarray(segment.offset,segment.offset+segment.length);gpu.submit(copied?part.slice():part,{});}};
  send(scene().call("BIND_TEXTURE",target,101));const image=cpu.boundImage(target).texture,settings=parameters.initial(target);
  assert.deepEqual([settings[GL.TEXTURE_MIN_FILTER][0],settings[GL.TEXTURE_WRAP_S][0],settings[GL.TEXTURE_WRAP_T][0],settings[GL.TEXTURE_WRAP_R][0],settings[GL.TEXTURE_BASE_LEVEL][0],101],reference.state.defaults);
  assert.equal(gpu.boundTexture(target).sampler.minFilter,GL.LINEAR);assert.equal(gpu.boundTexture(target).sampler.wrapS,GL.CLAMP_TO_EDGE);
  for (const p of [GL.TEXTURE_MIN_FILTER,GL.TEXTURE_WRAP_S,GL.TEXTURE_WRAP_T,GL.TEXTURE_WRAP_R,GL.TEXTURE_BASE_LEVEL]) {
   const s=new GLStream(),header=P.encodeRecord("QUERY_PARAMETER",{query_kind:P.C.V86GL_PARAMETER_TEXTURE,target,pname:p,value_kind:P.C.V86GL_STATE_FLOAT,data_size:32});
   s.record(P.GLFN.QUERY_PARAMETER,new Uint8Array([...header,...new Uint8Array(32)]));const r=s.payloadView();send(s);
   assert.equal(r.view.getUint32(P.F.QUERY_PARAMETER.status,true),1);assert.equal(r.view.getFloat64(header.length,true),settings[p][0],"CPU RECT default "+p);
  }
  assert.ok(caps.extensions(gpu.capabilities()).includes("GL_ARB_texture_rectangle"));assert.ok(caps.integer(gpu.capabilities(),GL.MAX_RECTANGLE_TEXTURE_SIZE)>=3);
  const bytes=new Uint8Array(256),bad=[
   s=>s.call("TEX_PARAMETERI",target,GL.TEXTURE_MIN_FILTER,GL.LINEAR_MIPMAP_LINEAR),
   ...[GL.TEXTURE_WRAP_S,GL.TEXTURE_WRAP_T,GL.TEXTURE_WRAP_R].map(p=>s=>s.call("TEX_PARAMETERI",target,p,GL.REPEAT)),
   s=>s.call("TEX_PARAMETERI",target,GL.TEXTURE_BASE_LEVEL,1),
   s=>s.texImage2D(target,1,GL.RGBA8,1,1,GL.RGBA,GL.UNSIGNED_BYTE,bytes),
   s=>s.record(P.GLFN.TEX_IMAGE_2D,new Uint8Array([...P.encodeRecord("TEX_IMAGE_2D",{target,level:0,internalformat:GL.RGBA8,width:3,height:3,border:1,format:GL.RGBA,type:GL.UNSIGNED_BYTE,data_size:bytes.length}),...bytes])),
   s=>s.compressedTexImage2D(target,0,GL.COMPRESSED_RGBA_S3TC_DXT1_EXT,4,4,bytes.subarray(0,8)),
   s=>s.texImage2D(target,0,GL.RGBA8,1,1,GL.COLOR_INDEX,GL.UNSIGNED_BYTE,bytes),
   s=>s.texImage2D(target,0,GL.RGBA8,-1,1,GL.RGBA,GL.UNSIGNED_BYTE,bytes),
   s=>s.call("COPY_TEX_IMAGE_2D",target,1,GL.RGBA8,0,0,1,1,0),
   s=>s.texSubImage2D(target,1,0,0,1,1,GL.RGBA,GL.UNSIGNED_BYTE,bytes),
   s=>s.call("GENERATE_MIPMAP",target),
   s=>s.record(P.GLFN.QUERY_TEXTURE_IMAGE,new Uint8Array([...P.encodeRecord("QUERY_TEXTURE_IMAGE",{target,level:1,format:GL.RGBA,type:GL.UNSIGNED_BYTE,mode:0})])),
   s=>s.record(P.GLFN.QUERY_PARAMETER,new Uint8Array([...P.encodeRecord("QUERY_PARAMETER",{query_kind:P.C.V86GL_PARAMETER_TEXTURE_LEVEL,target,pname:GL.TEXTURE_WIDTH,index:1,value_kind:P.C.V86GL_STATE_INTEGER,data_size:32}),...new Uint8Array(32)])),
   s=>s.call("BIND_TEXTURE",GL.TEXTURE_2D,101),
  ];
  for (const [i,call] of bad.entries()){send(call(new GLStream()));assert.equal(cpu.current.error,expected[i],"RECT error "+i);cpu.current.error=0;assert.equal(image.levels.size,0,"rejected call must not define image "+i);}
  const resources=gpu.current.shareGroup.textures.size;
  send(new GLStream().texImage2D(GL.PROXY_TEXTURE_RECTANGLE,0,GL.RGBA8,3,2,GL.RGBA,GL.UNSIGNED_BYTE,null));
  assert.equal(cpu.current.error,0);assert.equal(cpu.current.proxyImages.get(GL.PROXY_TEXTURE_RECTANGLE).get(0).width,3);assert.equal(gpu.current.shareGroup.textures.size,resources);
  send(new GLStream().texImage2D(GL.PROXY_TEXTURE_RECTANGLE,0,GL.RGBA8,caps.integer(gpu.capabilities(),GL.MAX_RECTANGLE_TEXTURE_SIZE)+1,2,GL.RGBA,GL.UNSIGNED_BYTE,null));
  assert.equal(cpu.current.error,0);assert.equal(cpu.current.proxyImages.get(GL.PROXY_TEXTURE_RECTANGLE).get(0).width,0);
  send(new GLStream().texImage2D(target,0,GL.RGBA8,3,2,GL.RGBA,GL.UNSIGNED_BYTE,new Uint8Array(24)).call("ENABLE",target).call("PUSH_ATTRIB",0x40000)
   .call("TEX_PARAMETERI",target,GL.TEXTURE_MAG_FILTER,GL.NEAREST).call("BIND_TEXTURE",GL.TEXTURE_2D,2).call("POP_ATTRIB"));
  assert.equal(cpu.current.error,0);assert.equal(gpu.boundTexture(target).sampler.magFilter,GL.LINEAR);assert.equal(cpu.current.units[0].get(target),101);
  const copy=new GLShadow();copy.setState(JSON.parse(JSON.stringify(cpu.getState())));assert.equal(copy.boundImage(target).texture.levels.get(0).get(0).width,3);
  assert.equal(gpu.stats.refusals,0);assert.equal(gpu.hostErrors.length,0);
 }
 console.log("PASS RECT state, defaults, normative errors, atomic rejection, independent bindings, attrib/snapshot metadata in both modes");
})().catch(error=>{console.error(error);process.exitCode=1;});
