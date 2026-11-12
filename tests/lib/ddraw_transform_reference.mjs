import assert from 'node:assert/strict';
export function parse_native_transform_text(transform,bound){
 assert(transform.includes('COMPLETE transform=1'));assert(bound.includes('COMPLETE bound=1'));
 for(const text of [transform,bound])assert(!text.split(/\r?\n/).filter(l=>!l.startsWith('VIEW ')).some(l=>/hr=(?!00000000)[0-9a-f]{8}/i.test(l)));
 const lines=(text,prefix)=>text.split(/\r?\n/).filter(l=>l.startsWith(prefix));
 const word=s=>parseInt(s,16);
 const views=lines(transform,'VIEW ').map(l=>{const m=/^VIEW case=(\d+) hr=([0-9a-f]{8}) x=(\d+) y=(\d+) w=(\d+) h=(\d+) min=([0-9a-f]{8}) max=([0-9a-f]{8})$/i.exec(l);assert(m,l);return{case:+m[1],hr:word(m[2]),words:[+m[3],+m[4],+m[5],+m[6],word(m[7]),word(m[8])]};});
 const vertices=lines(transform,'VERTEX ').map(l=>{const m=/^VERTEX case=(\d+) vertex=([0-3])((?: [0-9a-f]{8}){4})$/i.exec(l);assert(m,l);return{case:+m[1],vertex:+m[2],words:m[3].trim().split(' ').map(word)};});
 const matrices=lines(transform,'MATRIX ').map(l=>{const m=/^MATRIX state=(\d+) phase=([0-5])((?: [0-9a-f]{8}){16})$/i.exec(l);assert(m,l);return{state:+m[1],phase:+m[2],words:m[3].trim().split(' ').map(word)};});
 const bindings=lines(bound,'BOUND ').map(l=>{const m=/^BOUND phase=([0-4]) colors=([0-9a-f,]+) scale=([0-9a-f]{8}) x=([0-9a-f]{8})$/i.exec(l);assert(m,l);return{phase:+m[1],colors:m[2].split(',').map(word),scale:word(m[3]),x:word(m[4])};});
 assert.equal(views.length,11);assert.equal(matrices.length,84);assert.equal(bindings.length,5);
 assert.equal(new Set(views.map(r=>r.case)).size,11);assert.equal(new Set(matrices.map(r=>r.state+'/'+r.phase)).size,84);assert.equal(new Set(bindings.map(r=>r.phase)).size,5);
 assert.equal(vertices.length,views.filter(r=>!r.hr).length*4);assert.equal(new Set(vertices.map(r=>r.case+'/'+r.vertex)).size,vertices.length);
 const a=[1,0,0,0,0,1,0,0,0,0,1,0,2,3,4,1],b=[2,0,0,0,0,3,0,0,0,0,4,0,5,6,7,1],ba=[2,0,0,0,0,3,0,0,0,0,4,0,7,9,11,1];
 const bits=values=>Array.from(new Uint32Array(Float32Array.from(values).buffer));
 for(const r of matrices)assert.deepEqual(r.words,bits(r.phase===3?a:r.phase===5?b:ba));
 for(const r of views)assert.equal(r.hr,[6,7,10].includes(r.case)?0x80070057:0);
 const spans={0:[0,1],1:[0,0.001],2:[1,Math.fround(1.001)],3:[-2,4],4:[-1,Math.fround(-.999)],5:[2,3],8:[0,1],9:[0,1]};
 for(const r of views)if(!r.hr)assert.deepEqual(r.words.slice(4),bits(spans[r.case]));
 const zValues=[0,1,.5,.25],asFloat=word=>new Float32Array(new Uint32Array([word]).buffer)[0];
 for(const r of vertices){const range=spans[r.case];assert(Math.abs(asFloat(r.words[2])-(range[0]+zValues[r.vertex]*(range[1]-range[0])))<3e-7);assert.equal(r.words[3],0x3f800000);}
 const clear=0xab4e69,green=0xff00,colors=[[clear,green,green,clear],[clear,clear,clear,green],[clear,green,green,clear],[green,green,clear,clear],[clear,green,clear,clear]];
 for(const r of bindings){assert.deepEqual(r.colors,colors[r.phase]);assert.equal(r.scale,bits([r.phase===4?.5:1])[0]);assert.equal(r.x,bits([0,.75,0,-.75,-.375])[r.phase]);}
 return{views,vertices,matrices,bindings};
}
