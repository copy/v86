// Independent lane model: BigInt arithmetic, no Wasm or CPU implementation calls.
import assert from "node:assert/strict";
export function packed(op, destination, source) {
    if([0x0F14,0x0F15,0x660F14,0x660F15].includes(op)) op={0x0F14:0x62,0x0F15:0x6A,0x660F14:0x6C,0x660F15:0x6D}[op];
    // SSE4.1/SSE4.2 (66 0F 38 xx): their byte, kept apart from the 66 0F bytes
    const sse4=op>0xFFFFFF?op&255:undefined;
    op &= 255;
    if(op>=0x54&&op<=0x57)op=[0xDB,0xDF,0xEB,0xEF][op-0x54];
    const bytes = words => {const buffer=new ArrayBuffer(16),v=new DataView(buffer);words.forEach((x,i)=>v.setUint32(i*4,x,true));return new Uint8Array(buffer);};
    const a=bytes(destination),b=bytes(source),out=new Uint8Array(16);
    const read=(v,bits,lane)=>{let n=0n;for(let j=bits/8-1;j>=0;j--)n=n<<8n|BigInt(v[lane*bits/8+j]);return n;};
    const write=(n,bits,lane)=>{n=BigInt.asUintN(bits,n);for(let j=0;j<bits/8;j++){out[lane*bits/8+j]=Number(n&255n);n>>=8n;}};
    const signed=(v,bits,i)=>BigInt.asIntN(bits,read(v,bits,i));
    const result=()=>{const v=new DataView(out.buffer);return Array.from({length:4},(_,i)=>v.getUint32(i*4,true));};
    if(sse4===0x2B){
        // PACKUSDW: signed doublewords to unsigned words
        for(let half=0;half<2;half++) for(let i=0;i<4;i++){const n=signed(half?b:a,32,i);write(n<0n?0n:n>65535n?65535n:n,16,half*4+i);}
        return result();
    }
    const unpack=sse4===undefined&&{0x60:[8,0],0x61:[16,0],0x62:[32,0],0x68:[8,1],0x69:[16,1],0x6A:[32,1],0x6C:[64,0],0x6D:[64,1]}[op];
    if(unpack){
        const [bits,high]=unpack,start=high*64/bits;
        for(let i=0;i<64/bits;i++){write(read(a,bits,start+i),bits,i*2);write(read(b,bits,start+i),bits,i*2+1);}
        return result();
    }
    if(sse4===undefined&&[0x63,0x67,0x6B].includes(op)){
        const bits=op===0x6B?16:8,lo=op===0x67?0n:-(1n<<BigInt(bits-1)),hi=op===0x67?255n:-lo-1n;
        for(let half=0;half<2;half++) for(let i=0;i<64/bits;i++){
            const n=signed(half?b:a,bits*2,i);write(n<lo?lo:n>hi?hi:n,bits,half*64/bits+i);
        }
        return result();
    }
    const shift=sse4===undefined&&{0xD1:[16,"right"],0xD2:[32,"right"],0xD3:[64,"right"],0xE1:[16,"signed"],0xE2:[32,"signed"],0xF1:[16,"left"],0xF2:[32,"left"],0xF3:[64,"left"]}[op];
    if(shift){
        const [bits,kind]=shift,count=read(b,64,0),n=count>=BigInt(bits)?BigInt(bits):count;
        for(let i=0;i<128/bits;i++){
            const x=kind==="signed"?signed(a,bits,i):read(a,bits,i);
            write(kind==="left"?x<<n:x>>n,bits,i);
        }
        return result();
    }
    const spec=sse4!==undefined?{
        0x29:[64,"eq"],0x37:[64,"gt"],0x38:[8,"mins"],0x39:[32,"mins"],0x3A:[16,"minu"],0x3B:[32,"minu"],
        0x3C:[8,"maxs"],0x3D:[32,"maxs"],0x3E:[16,"maxu"],0x3F:[32,"maxu"],0x40:[32,"mull"],
    }[sse4]:{
        0xFC:[8,"add"],0xFD:[16,"add"],0xFE:[32,"add"],0xD4:[64,"add"],
        0xF8:[8,"sub"],0xF9:[16,"sub"],0xFA:[32,"sub"],0xFB:[64,"sub"],
        0xEC:[8,"adds"],0xED:[16,"adds"],0xDC:[8,"addu"],0xDD:[16,"addu"],
        0xE8:[8,"subs"],0xE9:[16,"subs"],0xD8:[8,"subu"],0xD9:[16,"subu"],
        0x64:[8,"gt"],0x65:[16,"gt"],0x66:[32,"gt"],
        0x74:[8,"eq"],0x75:[16,"eq"],0x76:[32,"eq"],
        0xDA:[8,"minu"],0xDE:[8,"maxu"],0xEA:[16,"mins"],0xEE:[16,"maxs"],
        0xE0:[8,"avg"],0xE3:[16,"avg"],0xE4:[16,"mulhu"],0xE5:[16,"mulhs"],
        0xF4:[64,"muld"],0xF6:[64,"sad"],0xD5:[16,"mull"],0xF5:[32,"madd"],
        0xDB:[128,"and"],0xDF:[128,"andnot"],0xEB:[128,"or"],0xEF:[128,"xor"],
    }[op];
    assert(spec,`missing packed model ${(sse4===undefined?op:0x660F3800|sse4).toString(16)}`);
    const [bits,kind]=spec,mask=(1n<<BigInt(bits))-1n,min=-(1n<<BigInt(bits-1)),max=-min-1n;
    const clamp=(n,lo,hi)=>n<lo?lo:n>hi?hi:n;
    for(let i=0;i<128/bits;i++){
        const x=read(a,bits,i),y=read(b,bits,i),sx=BigInt.asIntN(bits,x),sy=BigInt.asIntN(bits,y);
        let n;
        switch(kind){
            case "add": n=x+y;break;
            case "sub": n=x-y;break;
            case "adds": n=clamp(sx+sy,min,max);break;
            case "subs": n=clamp(sx-sy,min,max);break;
            case "addu": n=clamp(x+y,0n,mask);break;
            case "subu": n=clamp(x-y,0n,mask);break;
            case "gt": n=sx>sy?mask:0n;break;
            case "eq": n=x===y?mask:0n;break;
            case "minu": n=x<y?x:y;break;
            case "maxu": n=x>y?x:y;break;
            case "mins": n=sx<sy?sx:sy;break;
            case "maxs": n=sx>sy?sx:sy;break;
            case "avg": n=(x+y+1n)/2n;break;
            case "mulhu": n=x*y>>16n;break;
            case "mulhs": n=sx*sy>>16n;break;
            case "mull": n=x*y;break;
            case "muld": n=read(a,32,2*i)*read(b,32,2*i);break;
            case "madd": n=signed(a,16,2*i)*signed(b,16,2*i)+signed(a,16,2*i+1)*signed(b,16,2*i+1);break;
            case "sad": n=0n;for(let j=0;j<8;j++)n+=BigInt(Math.abs(a[8*i+j]-b[8*i+j]));break;
            case "and": n=x&y;break;
            case "andnot": n=~x&y;break;
            case "or": n=x|y;break;
            case "xor": n=x^y;break;
        }
        write(n,bits,i);
    }
    const v=new DataView(out.buffer);return Array.from({length:4},(_,i)=>v.getUint32(i*4,true));
}

function packed_immediate(op, group, count, destination) {
    if(op===0x660F73&&[3,7].includes(group)){
        let value=destination.reduce((n,x,i)=>n|BigInt(x)<<BigInt(32*i),0n);
        const shift=BigInt(Math.min(count,16)*8);
        value=group===7?value<<shift:value>>shift;
        value=BigInt.asUintN(128,value);
        return Array.from({length:4},(_,i)=>Number(value>>BigInt(32*i)&0xFFFFFFFFn));
    }
    const operation={2:0xD1,4:0xE1,6:0xF1}[group]+(op&255)-0x71;
    return packed(0x660F00|operation,destination,[count,0,0,0]);
}
export { packed_immediate as packedImmediate };
