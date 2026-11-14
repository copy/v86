'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
const root=path.resolve(__dirname,'../..'),draft=process.env.NOOVERWRITE_DRAFT||root;
for(const name of['d9wg_draw_recorder','d9wg_resources','d3d9_executor']){const relative='src/browser/glbridge/d3d9-webgpu/'+name+'.js',file=root+'/'+relative,m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(draft+'/'+relative,'utf8'),file);require.cache[file]=m;}
const P=require(root+'/src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js'),{makeExecutor}=require(root+'/tests/glbridge/d3d9_webgpu_executor_test.js');
const {executor:e}=makeExecutor();let checks=0;
(async()=>{await e.submit(P.encodeBatch([{opcode:P.OP.CREATE_DEVICE,payload:P.encode('CreateDevice',{device_handle:1,width:8,height:8})}]),{writeGuestMemory(){}});

function must(value,message){checks++;assert(value,message);}
function upload(buffer,at,data,no){e.stageBufferUpload(buffer,at,Uint8Array.from(data),no);return e.frame.ops.find(op=>op.kind==='buffer-upload'&&op.destination===buffer&&op.destinationOffset===at&&op.size===data.length&&op.sourceOffset===e.uploads.cursor-data.length);}
function draw(name,buffer,at,count){const op={kind:'ordering-probe',name,buffer,at,count};e.ensureFrame().record(op);return op;}
function reset(){e.discardFrame();}
// A normal update stays after its earlier draw. NOOVERWRITE can be inserted
// after initialisation, before pending draws, and never before prior writes.
for(const flags of[0,0x2000,0x1000,0x3000]){
 reset();const buffer={size:16},resource={gpuBuffer:buffer,shadow:new Uint8Array(16)};e.applyBufferUpdate(resource,0,new Uint8Array(16).fill(1),0,16,0);const a=draw('a',buffer,0,16);e.applyBufferUpdate(resource,0,new Uint8Array(16).fill(2),0,16,flags);const ops=e.frame.ops;must(ops.length===3,'two uploads and one draw');must(ops.indexOf(a)===(flags&0x1000?2:1),'NOOVERWRITE alone changes pending draw order');must(ops[0].kind==='buffer-upload','initialisation remains first');must(resource.shadow.every(v=>v===2),'full CPU mirror is current');
}
for(let round=0;round<128;round++){
 reset();const buffer={size:64},other={size:64},opdata=new Map(),written=[];
 function u(destination,at,count,value,no){const before=e.frame?.ops.slice()||[];e.stageBufferUpload(destination,at,new Uint8Array(count).fill(value),no);const op=e.frame.ops.find(op=>!before.includes(op));assert(op);opdata.set(op,new Uint8Array(count).fill(value));written.push(op);return op;}
 u(buffer,0,64,1,false);const a=draw('a',buffer,0,16);u(other,0,64,7,false);u(buffer,16,16,2,false);const b=draw('b',buffer,16,16);const at=(round*7)%60&~3,count=4;const c=u(buffer,at,count,3,true),ops=e.frame.ops;
 for(const old of written.slice(0,-1))if(old.destination===buffer&&old.destinationOffset<at+count&&at<old.destinationOffset+old.size)must(ops.indexOf(old)<ops.indexOf(c),'overlapping writes stay before new NOOVERWRITE');
 if(at<16||at>=32)must(ops.indexOf(c)<ops.indexOf(a),'unrelated buffer/range updates do not synchronise NOOVERWRITE');
 must(ops.includes(a)&&ops.includes(b)&&ops.length===6,'draw identities and other-buffer uploads retained');
 // Independent byte-copy interpreter checks final contents and promised
 // disjoint draw ranges, including earlier normal uploads sharing a word.
 const memory=new Uint8Array(64),otherMemory=new Uint8Array(64),seen={};for(const op of ops){if(op.kind==='buffer-upload')(op.destination===buffer?memory:otherMemory).set(opdata.get(op),op.destinationOffset);else seen[op.name]=memory.slice(op.at,op.at+op.count);}
 const final=new Uint8Array(64).fill(1);final.fill(2,16,32);final.fill(3,at,at+count);must(Buffer.from(memory).equals(Buffer.from(final)),'latest overlapping write remains final');must(otherMemory.every(v=>v===7),'other buffer identity unaffected');if(at>=16)must(seen.a.every(v=>v===1),'legal nonoverlap update preserves earlier draw');if(at<16||at>=32)must(seen.b.every(v=>v===2),'legal nonoverlap update preserves later draw');
}
reset();const resource={gpuBuffer:{size:16},stripIndexBuffer:{size:32},byteCount:16,shadow:new Uint8Array(16)};e.applyBufferUpdate(resource,0,new Uint8Array(16).fill(1),0,16,0);const a=draw('strip',resource.stripIndexBuffer,0,32);e.applyBufferUpdate(resource,2,new Uint8Array([5,0]),0,2,0x1000);const ops=e.frame.ops;must(ops.indexOf(a)===4,'strip mirror and native buffer both updated before pending draw');must(resource.shadow[0]===1&&resource.shadow[1]===1&&resource.shadow[2]===5&&resource.shadow[3]===0&&resource.shadow[4]===1,'unaligned update preserves adjacent bytes');reset();
console.log('PASS NOOVERWRITE recorded ordering '+checks+' checks; actual resource updates, normal/discard/combined flags, overlapping write barriers, aligned borders, buffer identity, strip mirrors and legal disjoint draw equivalence');

})().catch(e=>{console.error(e);process.exitCode=1;});
