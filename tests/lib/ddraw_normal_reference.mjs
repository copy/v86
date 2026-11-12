import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export function assert_native_normal_text(text){
 assert(text.includes('COMPLETE api7=1 api3=1'));assert(!/hr=(?!00000000)[0-9a-f]{8}/i.test(text));
 const cpu=text.split(/\r?\n/).filter(l=>l.startsWith('CPU ')).map(l=>{const m=/^CPU api=(3|7) matrix=(\d+) normalize=(0|1) vertex=([0-3]) diffuse=([0-9a-f]{8}) specular=([0-9a-f]{8})$/i.exec(l);assert(m,l);return{api:+m[1],matrix:+m[2],normalize:+m[3],vertex:+m[4],diffuse:parseInt(m[5],16),specular:parseInt(m[6],16)};});
 const pixels=text.split(/\r?\n/).filter(l=>l.startsWith('PIXEL ')).map(l=>{const m=/^PIXEL api=(3|7) matrix=(\d+) normalize=(0|1) color=([0-9a-f]{8})$/i.exec(l);assert(m,l);return{api:+m[1],matrix:+m[2],normalize:+m[3],color:parseInt(m[4],16)};});
 const history=text.split(/\r?\n/).filter(l=>l.startsWith('HISTORY ')).map(l=>{const m=/^HISTORY normalize=(0|1) sequence=([0-2]) step=([0-2]) diffuse=([0-9a-f]{8})$/i.exec(l);assert(m,l);return{normalize:+m[1],sequence:+m[2],step:+m[3],diffuse:parseInt(m[4],16)};});
 assert.equal(cpu.length,208);assert.equal(new Set(cpu.map(r=>[r.api,r.matrix,r.normalize,r.vertex].join('/'))).size,208);assert.equal(pixels.length,52);assert.equal(new Set(pixels.map(r=>[r.api,r.matrix,r.normalize].join('/'))).size,52);assert.equal(history.length,18);assert.equal(new Set(history.map(r=>[r.normalize,r.sequence,r.step].join('/'))).size,18);
 const old=[0xff,0xb4,0xff,0xff,0xff,0x89,0x89,0,0,0x48,0,0,0x89],modern=[[0xff,0,0xff,0,0xff,0xff,0x90,0x3c,0,0x90,0xff,0xff,0xff],[0xff,0xff,0xff,0,0xfa,0xa1,0x34,0x62,0,0x34,0xb4,0xb4,0x74]];
 for(const r of cpu){assert(r.matrix<13);assert.equal(r.diffuse,(0xff000000|(r.api===3?old[r.matrix]:modern[r.normalize][r.matrix]))>>>0);assert.equal(r.specular,0);}
 for(const r of pixels){const match=cpu.find(v=>v.api===r.api&&v.matrix===r.matrix&&v.normalize===r.normalize);assert(match);assert.equal(r.color&0xffffff,match.diffuse&0xffffff);}
 for(const r of history){const value=r.step===0?(r.normalize?0x6f:0x78):r.step===1?0:r.normalize||r.sequence===2?0:0x78;assert.equal(r.diffuse,(0xff000000|value)>>>0);}
 for(const line of ['INITIAL api=7 normalize=00000000','INITIAL api=3 normalize=ffffffff','STATE api=7 normalize=0 value=00000000','STATE api=7 normalize=1 value=00000001','STATE api=3 normalize=0 value=00000000','STATE api=3 normalize=1 value=00000001'])assert(text.includes(line),line);
 return{cpu,pixels,history};
}

// Compile only the native probe's input data, never proxy transform/lighting code.
export function native_normal_inputs(source){
 const worlds=/static const float worlds\[\]\[16\]=\{[\s\S]*?\n};/.exec(source);assert(worlds);
 const start=source.indexOf('static void vertices_for'),end=source.indexOf('static void cpu_rows',start);assert(start>=0&&end>start);
 const viewSetup='if(kind==6){m._11=3;m._22=.5f;m._33=2;}if(kind==12){m._13=.3f;m._21=.25f;m._32=.5f;}';
 assert.equal(source.split(viewSetup).length,3,'Both original API probe view setups must match');
 const main=String.raw`
int main(void){puts("[");for(unsigned k=0;k<13;k++){struct Vertex v[4];vertices_for(k,v);float view[16];memcpy(view,worlds[0],64);if(k==6){view[0]=3;view[5]=.5f;view[10]=2;}if(k==12){view[2]=.3f;view[4]=.25f;view[9]=.5f;}printf("%s{\"matrix\":%u,\"world\":[",k?",":"",k);for(unsigned i=0;i<16;i++)printf("%s%.9g",i?",":"",worlds[k][i]);printf("],\"view\":[");for(unsigned i=0;i<16;i++)printf("%s%.9g",i?",":"",view[i]);printf("],\"vertices\":[");for(unsigned i=0;i<4;i++){printf("%s[",i?",":"");for(unsigned c=0;c<3;c++)printf("%s%.9g",c?",":"",v[i].p[c]);for(unsigned c=0;c<3;c++)printf(",%.9g",v[i].n[c]);printf("]");}printf("]}");}puts("]");return 0;}
`;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ddraw-normal-inputs-'));
 try{const file=path.join(dir,'inputs.c'),exe=path.join(dir,'inputs');fs.writeFileSync(file,'#include <stdio.h>\n#include <string.h>\nstruct Vertex{float p[3],n[3];};\n'+worlds[0]+'\n'+source.slice(start,end)+main);execFileSync(process.env.HOST_CC||'cc',['-std=c11','-O1','-Wall','-Wextra','-Werror',file,'-o',exe]);return JSON.parse(execFileSync(exe,{encoding:'utf8'}));}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
