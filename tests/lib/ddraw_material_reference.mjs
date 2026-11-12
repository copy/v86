import assert from 'node:assert/strict';
export function assert_native_material_text(text){
 assert(text.includes('COMPLETE api3=1'));
 const failed=text.split(/\r?\n/).filter(l=>/hr=(?!00000000)[0-9a-f]{8}/i.test(l));
 assert.deepEqual(failed,['LIGHT duplicate hr=887602ef','BG zero_initial hr=80070057','BG zero_bound hr=80070057']);
 for(const line of ['BG phase=initial handle=0 valid=0','BG phase=bound same=1 valid=1','BG phase=after_zero same=1 valid=1'])assert(text.includes(line));
 const pixels=text.split(/\r?\n/).filter(l=>l.startsWith('PIXEL '));assert.deepEqual(pixels,['PIXEL phase=background color=00ff0000','PIXEL phase=material bound=0 red=0 color=00ffffff','PIXEL phase=material bound=0 red=1 color=00ff0000','PIXEL phase=material bound=1 red=0 color=0000ff00','PIXEL phase=material bound=1 red=1 color=0000ff00']);
 const rows=text.split(/\r?\n/).filter(l=>l.startsWith('CPU ')).map(l=>{const m=/^CPU bound=(\d) red=(\d) lit=(\d) keep=(\d) vertex=(\d) diffuse=([0-9a-f]{8}) specular=([0-9a-f]{8}) u=([0-9a-f]{8}) v=([0-9a-f]{8})$/i.exec(l);assert(m,l);return{bound:+m[1],red:+m[2],lit:+m[3],keep:+m[4],vertex:+m[5],diffuse:parseInt(m[6],16),specular:parseInt(m[7],16),u:parseInt(m[8],16),v:parseInt(m[9],16)};});
 assert.equal(rows.length,64);assert.equal(new Set(rows.map(r=>[r.bound,r.red,r.lit,r.keep,r.vertex].join('/'))).size,64);
 for(const r of rows){assert(r.vertex<4);assert.equal(r.diffuse,r.bound&&r.lit?0xff00ff00:r.red?0xffff0000:0xffffffff);assert.equal(r.specular,0);assert.equal(r.u,0x3e800000);assert.equal(r.v,0x3f400000);}
 return{pixels,rows};
}
