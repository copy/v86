import assert from 'node:assert/strict';
export function assert_native_lighting_text(text){
 assert(text.includes('COMPLETE api7=1 api3=1'));assert(!/hr=(?!00000000)[0-9a-f]{8}/i.test(text),'Native API failure');
 const rows=text.split(/\r?\n/).filter(l=>l.startsWith('PV ')).map(l=>{const m=/^PV api=(\d+) phase=(\w+) kind=(\d+) power=(\d+) colors=(\d+) cv=(\d+) src=(\d+) vertex=(\d+) diffuse=([0-9a-f]{8}) specular=([0-9a-f]{8})$/i.exec(l);assert(m,l);return{api:+m[1],phase:m[2],kind:+m[3],power:+m[4],colors:+m[5],cv:+m[6],source:+m[7],vertex:+m[8],diffuse:parseInt(m[9],16),specular:parseInt(m[10],16)};});
 assert.equal(rows.length,432);assert.equal(new Set(rows.map(r=>[r.api,r.phase,r.kind,r.power,r.colors,r.cv,r.source,r.vertex].join('/'))).size,432);
 const subset=(api,phase,kind,power)=>rows.filter(r=>r.api===api&&r.phase===phase&&r.kind===kind&&r.power===power).map(r=>r.specular);
 for(const r of rows){assert(r.vertex<9&&[3,7].includes(r.api));const alpha=r.api===3?0:r.colors&&r.cv&&r.source? r.source===1?0x40:0xc0:0x80;assert.equal(r.specular>>>24,alpha);if(r.api===3&&[0,2,4].includes(r.power))assert.equal(r.specular,0);}
 for(let kind=1;kind<=3;kind++){assert.deepEqual(subset(7,'sequence',kind,1),subset(7,'sequence',kind,2));assert.deepEqual(subset(7,'sequence',kind,3),subset(7,'sequence',kind,4));}
 assert(subset(7,'sequence',1,0).every(c=>c===0x80000000));const five=subset(7,'sequence',3,4);assert.equal(five.length,9);
 for(const phase of ['set_without_process','new_destination','record_during','record_end'])assert.deepEqual(subset(7,phase,3,0),five);
 assert.deepEqual(subset(7,'record_apply',3,17),subset(7,'record_zero',3,0));assert.notDeepEqual(subset(7,'record_apply',3,17),five);
 return rows;
}
