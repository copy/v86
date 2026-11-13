import assert from 'node:assert/strict';import fs from 'node:fs';
import{compare_window_events,normalize_window_event}from'../lib/ddraw_window_trace.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('fixtures/ddraw_native_windows.json',import.meta.url))),{events,windows}=fixture;
assert.deepEqual(compare_window_events(events,events,windows),{mandatoryMessages:68,actualMessages:68,exactSelectedMessages:true,additionalZOrderNotifications:[]});
const extra='EVENT case=0 name=normal index=6 message=0047 wp=00000000 xy=0,0 size=800,600 flags=00001813 after=00123456 screen=800,600';
const at=events.findIndex(l=>l.includes('case=0 name=normal index=6 '));assert(at>0);const changed=[...events.slice(0,at),extra,...events.slice(at)];
const report=compare_window_events(events,changed,windows);assert.equal(report.mandatoryMessages,68);assert.equal(report.actualMessages,69);assert.deepEqual(report.additionalZOrderNotifications,[extra]);assert(!report.exactSelectedMessages);
assert.equal(normalize_window_event('EVENT message=007D after=00123456'),'EVENT message=007D after=00123456');assert.match(normalize_window_event('EVENT message=0047 after=00000001'),/after=00000001/);
let rejected=0;for(const replacement of [extra.replace('800,600','799,600'),extra.replace('flags=00001813','flags=00001810'),extra.replace('message=0047','message=0005'),extra.replace('name=normal','name=mode'),extra.replace('xy=0,0','xy=1,0'),extra.replace('after=00123456','after=FFFFFFFF'),extra.replace('wp=00000000','wp=00000001')]){assert.throws(()=>compare_window_events(events,[...events.slice(0,at),replacement,...events.slice(at)],windows));rejected++;}
assert.throws(()=>compare_window_events(events,[...events.slice(0,at),extra,extra,...events.slice(at)],windows));rejected++;
assert.throws(()=>compare_window_events(events,events.filter((_,i)=>i!==at),windows));rejected++;
const reordered=[...events];[reordered[at],reordered[at+1]]=[reordered[at+1],reordered[at]];assert.throws(()=>compare_window_events(events,reordered,windows));rejected++;
console.log(`PASS window trace contract:68 mandatory native messages, one separately reported no-geometry z-order completion;${rejected} malformed/missing/reordered controls rejected`);
