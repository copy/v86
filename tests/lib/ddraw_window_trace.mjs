import assert from 'node:assert/strict';
const special=new Set(['00000000','00000001','FFFFFFFF','FFFFFFFE','FFFFFFFD']);
export function normalize_window_event(line){
    line=line.replace(/ index=\d+ /,' ');
    return /message=004[67] /.test(line)?line.replace(/after=([0-9A-F]{8})/g,(all,n)=>special.has(n)?all:'after=WINDOW'):line;
}
function fields(line){return Object.fromEntries([...line.matchAll(/(\w+)=([^ ]+)/g)].map(([,k,v])=>[k,v]));}
// Like the original Wine test_proc, require each expected message in order.
// The only additional selected message accepted here is an immediate z-order
// completion with NOMOVE|NOSIZE|NOACTIVATE, after the matching native request.
// Geometry, style, procedure and foreground snapshots are compared separately.
export function compare_window_events(reference,actual,windows){
    const expected=reference.map(normalize_window_event),observed=actual.map(normalize_window_event),extra=[];
    let next=0;
    for(let i=0;i<observed.length;i++){
        if(observed[i]===expected[next]){next++;continue;}
        const row=fields(observed[i]),previous=fields(observed[i-1]||'');
        const window=windows.map(fields).find(w=>w.case===row.case&&w.name===row.name);
        const rectangle=window?.outer.split(',').map(Number);
        const permitted=row.name==='normal'&&row.message==='0047'&&row.flags==='00001813'&&row.wp==='00000000'&&
            previous.case===row.case&&previous.name===row.name&&previous.message==='0046'&&previous.flags==='00000013'&&
            previous.after===row.after&&previous.screen===row.screen&&rectangle&&
            row.xy===rectangle.slice(0,2).join(',')&&row.size===[rectangle[2]-rectangle[0],rectangle[3]-rectangle[1]].join(',');
        assert(permitted,'Unexpected selected window message: '+actual[i]);
        extra.push(actual[i]);
    }
    assert.equal(next,expected.length,'Missing mandatory native messages');
    return {mandatoryMessages:expected.length,actualMessages:actual.length,exactSelectedMessages:extra.length===0,additionalZOrderNotifications:extra};
}
