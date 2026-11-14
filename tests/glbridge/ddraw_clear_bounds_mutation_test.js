'use strict';const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js'),'utf8'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'ddraw-clear-bounds-'));
const rows=[
 ['command header flags lost','view.getUint16(offset + D9WG.F.CommandHeader.flags, true));','0);'],
 ['dispatch drops caller flag','length, metadata, commandFlags);','length, metadata, 0);'],
 ['caller uses current viewport','callerBounds || state.viewport','state.viewport'],
 ['caller width read from height','boundsAt + D9WG.F.ClearBounds.width','boundsAt + D9WG.F.ClearBounds.height'],
 ['trailer starts before inline rectangles','const boundsAt = offset + rectsEnd;','const boundsAt = offset + D9WG.STRUCTS.Clear.size;'],
 ['caller incorrectly clipped by device scissor','!hasBounds && (state.renderStates.get(D3DRS_SCISSORTESTENABLE)','(state.renderStates.get(D3DRS_SCISSORTESTENABLE)'],
 ['missing bounds unchecked','(hasBounds ? D9WG.STRUCTS.ClearBounds.size : 0)','0'],
];
try{for(const[label,from,to]of rows){assert.equal(source.split(from).length,2,label);const file=dir+'/mutated.js';fs.writeFileSync(file,source.replace(from,to));const r=spawnSync(process.execPath,[__dirname+'/ddraw_clear_bounds_test.js'],{encoding:'utf8',env:{...process.env,DDRAW_CLEAR_EXECUTOR_SOURCE:file}});assert.notEqual(r.status,0,label);assert.match(r.stderr,/AssertionError/,label+': executed contract assertion required');assert(!/SyntaxError|Cannot find module/.test(r.stderr),r.stderr);console.log('KILL '+label);}console.log('PASS clear bounds mutations '+rows.length+'/'+rows.length+' executed implementations rejected');}finally{fs.rmSync(dir,{recursive:true,force:true});}
