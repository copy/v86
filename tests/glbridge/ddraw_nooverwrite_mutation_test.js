'use strict';const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=process.env.NOOVERWRITE_DRAFT||path.resolve(__dirname,'../..'),relative='src/browser/glbridge/d3d9-webgpu/',dir=fs.mkdtempSync(path.join(os.tmpdir(),'nooverwrite-mut-')),names=['d3d9_executor.js','d9wg_resources.js','d9wg_draw_recorder.js'];
const rows=[
 ['flags ignored','d9wg_resources.js','(lockFlags & 0x1000) !== 0','false'],
 ['ordinary writes promoted','d9wg_resources.js','(lockFlags & 0x1000) !== 0','true'],
 ['strip mirror stays synchronised','d9wg_resources.js','new Uint8Array(widened.buffer), noOverwrite);','new Uint8Array(widened.buffer));'],
 ['executor drops hint','d3d9_executor.js','if (noOverwrite) frame.recordNoOverwriteUpload(op);','if (false && noOverwrite) frame.recordNoOverwriteUpload(op);'],
 ['overlapping earlier write overtaken','d9wg_draw_recorder.js','position = i + 1;','position = 0;'],
 ['different buffers falsely alias','d9wg_draw_recorder.js','previous.destination === op.destination &&','true &&'],
 ['disjoint ranges falsely alias','d9wg_draw_recorder.js','previous.destinationOffset < end &&','true &&'],
 ['adjacent range falsely overlaps','d9wg_draw_recorder.js','previous.destinationOffset < end &&','previous.destinationOffset <= end &&'],
];
try{for(const[label,name,from,to]of rows){for(const n of names){const q=dir+'/'+relative+n;fs.mkdirSync(path.dirname(q),{recursive:true});fs.copyFileSync(root+'/'+relative+n,q);}const p=dir+'/'+relative+name,s=fs.readFileSync(p,'utf8');assert.equal(s.split(from).length,2,label);fs.writeFileSync(p,s.replace(from,to));const r=spawnSync(process.execPath,[__dirname+'/ddraw_nooverwrite_test.js'],{encoding:'utf8',env:{...process.env,NOOVERWRITE_DRAFT:dir}});assert.notEqual(r.status,0,label);assert.match(r.stderr,/AssertionError/,label+': runtime assertion required');assert(!/SyntaxError|TypeError|ReferenceError/.test(r.stderr),r.stderr);console.log('KILL '+label);}console.log('PASS NOOVERWRITE '+rows.length+'/'+rows.length+' runtime mutants');}finally{fs.rmSync(dir,{recursive:true,force:true});}
