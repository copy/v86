// Lane-based reference, independent of the IR byte-shuffle map and Wasm encoding.
export function shuffle(op, immediate, destination, source) {
    if(op===0x660F70) return [0,1,2,3].map(i=>source[immediate>>2*i&3]);
    if(op===0x0FC6) return [destination[immediate&3],destination[immediate>>2&3],source[immediate>>4&3],source[immediate>>6&3]];
    if(op===0x660FC6){const a=(immediate&1)*2,b=(immediate>>1&1)*2;return [...destination.slice(a,a+2),...source.slice(b,b+2)];}
    // BLENDPS, BLENDPD, PBLENDW: imm8 bit i takes element i from the source
    if(op===0x660F3A0C) return [0,1,2,3].map(i=>(immediate>>i&1?source:destination)[i]);
    if(op===0x660F3A0D) return [0,1,2,3].map(i=>(immediate>>(i>>1)&1?source:destination)[i]);
    if(op===0x660F3A0E){
        const half=v=>v.flatMap(x=>[x&65535,x>>>16]),d=half(destination),s=half(source),r=d.map((x,i)=>immediate>>i&1?s[i]:x);
        return [0,1,2,3].map(i=>(r[2*i]|r[2*i+1]<<16)>>>0);
    }
    const words=source.flatMap(x=>[x&65535,x>>>16]),result=words.slice(),start=op===0xF30F70?4:0;
    if(![0xF20F70,0xF30F70].includes(op)) throw new Error(`unknown shuffle ${op.toString(16)}`);
    for(let i=0;i<4;i++)result[start+i]=words[start+(immediate>>2*i&3)];
    return [0,1,2,3].map(i=>(result[2*i]|result[2*i+1]<<16)>>>0);
}
