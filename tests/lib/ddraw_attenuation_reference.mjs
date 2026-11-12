import assert from 'node:assert/strict';
function observations(text){assert(text.includes('COMPLETE specular=1'));assert(!/hr=(?!00000000)[0-9a-f]{8}/i.test(text));const rows=text.split(/\r?\n/).filter(l=>l.startsWith('GRID ')).map(l=>{const m=/^GRID z=([0-3]) kind=([1-3]) range=([0-4]) attenuation=([0-3]) power=([0-3]) vertex=([0-8]) diffuse=([0-9a-f]{8}) specular=([0-9a-f]{8})$/i.exec(l);assert(m,l);return{z:+m[1],kind:+m[2],range:+m[3],attenuation:+m[4],power:+m[5],vertex:+m[6],diffuse:parseInt(m[7],16),specular:parseInt(m[8],16)};});assert.equal(rows.length,8640);assert.equal(new Set(rows.map(r=>[r.z,r.kind,r.range,r.attenuation,r.power,r.vertex].join('/'))).size,8640);return rows;}

export function assert_native_attenuation_text(text,vertexText){
 const rows=observations(text),lookup=new Map(rows.map(r=>[[r.z,r.kind,r.range,r.attenuation,r.power,r.vertex].join('/'),r]));
 for(const r of rows){assert.equal(r.diffuse>>>24,255);assert.equal(r.specular>>>24,0);for(const value of [r.diffuse,r.specular])assert.equal(value&255,(value>>>8)&255),assert.equal(value&255,(value>>>16)&255);}
 // Freeze independently observed controls; the full rows remain native data.
 const value=(z,k,range,a,p,v)=>lookup.get([z,k,range,a,p,v].join('/'));
 assert.equal(value(1,1,0,0,1,4).specular,0);assert.equal(value(1,1,0,0,1,4).diffuse,0xff000000);
 assert.equal(value(1,1,1,1,1,4).specular,0x808080);assert.equal(value(1,1,1,2,1,4).specular,0x404040);
 assert.equal(value(1,1,3,2,2,4).specular,0xfafafa);assert.equal(value(1,1,3,2,2,1).specular,0x090909);
 for(const r of rows.filter(r=>r.kind===3)){assert.equal(r.diffuse,0xffffffff);assert.equal(r.specular,value(r.z,3,0,0,r.power,r.vertex).specular);}
 assert(vertexText.includes('COMPLETE vertex=1'));assert(vertexText.includes('LOCK first=00000000 second=00000000 same=1'));
 const locks=[],unlocks=[];
 for(const log of [text,vertexText])for(const line of log.split(/\r?\n/)){
  let m=/^NEST api=(3|7) combination=([0-3]) first=([0-9a-f]{8}) second=([0-9a-f]{8}) same=(0|1)$/i.exec(line);if(m){assert.equal(m[3],'00000000');assert.equal(m[4],'00000000');assert.equal(+m[5],1);locks.push({api:+m[1],combination:+m[2]});}
  m=/^RELEASE api=(3|7) combination=([0-3]) index=([0-2]) result=([0-9a-f]{8})$/i.exec(line);if(m){assert.equal(m[4],'00000000');unlocks.push({api:+m[1],combination:+m[2],index:+m[3]});}
 }
 assert.equal(locks.length,8);assert.equal(unlocks.length,24);assert.equal(new Set(locks.map(r=>r.api+'/'+r.combination)).size,8);
 for(let i=0;i<3;i++)assert(vertexText.includes('UNLOCK index='+i+' hr=00000000'));
 const vertices=vertexText.split(/\r?\n/).filter(l=>l.startsWith('VERTEX ')).map(l=>{const m=/^VERTEX weights=([0-3]) vertex=([0-3])((?: [0-9a-f]{8}){4})$/i.exec(l);assert(m,l);return{weights:+m[1],vertex:+m[2],words:m[3].trim().split(' ').map(n=>parseInt(n,16))};});assert.equal(vertices.length,16);
 for(let i=0;i<4;i++)assert(vertexText.includes('BLEND weights='+i+' hr=00000000'));
 const controls=[[[128,128,0,1],[192,64,1,1],[64,192,.5,1]],[[128,128,0,1],[149.333333,64,1/3,1/3],[76.8,153.6,.6,.8]],[[128,64,1,1],null,[42.6666667,256,1/3,4/3]],[[128,64,1,1],null,[42.6666667,256,1/3,4/3]]];
 for(const r of vertices){if(r.vertex===3)continue;const expected=controls[r.weights][r.vertex],values=Array.from(new Float32Array(new Uint32Array(r.words).buffer));if(expected)values.forEach((v,i)=>assert(Math.abs(v-expected[i])<.00002));else values.forEach(v=>assert(Number.isNaN(v)));}
 return{rows,vertexCompatibility:{locks,unlocks,vertices,scope:'First three vertices are bounded input observations. The fourth malformed vertex can read past native backing and is recorded without a portable expectation.'}};
}
