// Original NV40 shader decoder. Encoding facts: Mesa nv30/nv40_vertprog.h,
// nvfx_shader.h and envytools' XF ISA documentation (MIT).
const VEC = ["NOP","MOV","MUL","ADD","MAD","DP3","DPH","DP4","DST","MIN","MAX","SLT","SGE","ARL","FRC","FLR","SEQ","SFL","SGT","SLE","SNE","STR","SSG","ARR","ARA","TXL"];
const SCA = ["NOP","MOV","RCP","RCC","RSQ","EXP","LOG","LIT",null,"BRA",null,"CAL","RET","LG2","EX2","SIN","COS",null,null,"PUSHA","POPA"];
const FP = ["NOP","MOV","MUL","ADD","MAD","DP3","DP4","DST","MIN","MAX","SLT","SGE","SLE","SGT","SNE","SEQ","FRC","FLR","KIL","PK4B","UP4B","DDX","DDY","TEX","TXP","TXD","RCP",null,"EX2","LG2",null,null,"STR","SFL","COS","SIN","PK2H","UP2H",null,"PK4UB","UP4UB","PK2US","UP2US",null,null,null,"DP2A","TXL",null,"TXB"];
const swizzle = (v, shifts) => shifts.map(shift => v >>> shift & 3);
const reverse_mask = mask => (mask & 8) >>> 3 | (mask & 4) >>> 1 | (mask & 2) << 1 | (mask & 1) << 3;

export function decode_vertex_instruction(words, pc = 0)
{
    if(words.length !== 4) throw new RangeError("NV40 vertex instruction needs four DWORDs");
    const [a,b,c,d] = words, input = b >>> 8 & 15, constant = b >>> 12 & 255;
    const selectors = [(b & 255) << 9 | c >>> 23, c >>> 6 & 0x1FFFF, (c & 63) << 11 | d >>> 21];
    const sources = selectors.map((bits,i) => ({type: ["invalid","temp","input","constant"][bits & 3],
        index: (bits & 3) === 1 ? bits >>> 2 & 31 : (bits & 3) === 2 ? input : constant,
        swizzle: swizzle(bits,[14,12,10,8]), negate: !!(bits & 0x10000), absolute: !!(a & 1 << (21+i))}));
    const output = d >>> 2 & 31, vec = b >>> 22 & 31, sca = b >>> 27;
    return {pc, words: Array.from(words), sources,
        vector: {opcode: vec, name: VEC[vec] || null, type: a & 0x40000000 ? "output" : "temp",
            index: a & 0x40000000 ? output : a >>> 15 & 63, mask: reverse_mask(d >>> 13 & 15)},
        scalar: {opcode: sca, name: SCA[sca] || null, type: d & 0x1000 ? "output" : "temp",
            index: d & 0x1000 ? output : d >>> 7 & 31, mask: reverse_mask(d >>> 17 & 15)},
        predicate: {enabled: !!(a & 0x2000), update: !!(a & 0x4000), vector: !!(a & 0x20000000), register: a >>> 25 & 1,
            condition: a >>> 10 & 7, swizzle: swizzle(a,[8,6,4,2])},
        address: {register: a >>> 24 & 1, component: a & 3, input: !!(a & 0x08000000), output: !!(a & 0x10000000), constant: !!(d & 2)},
        target: (c & 63) << 3 | d >>> 29, saturate: !!(a & 0x04000000), end: !!(d & 1)};
}

export function decode_vertex_program(words, first = 0, entry = first)
{
    if(words.length % 4 || words.length > 544*4) throw new RangeError("NV40 vertex program size");
    const decoded=new Map(),pending=[entry];let ended=false,last=0;
    while(pending.length)
    {
        const pc=pending.pop();if(decoded.has(pc))continue;
        const at=(pc-first)*4;
        if(at<0 || at+4>words.length)throw new RangeError("NV40 vertex program has no end or branch outside program");
        const i=decode_vertex_instruction(words.slice(at,at+4),pc);decoded.set(pc,i);last=Math.max(last,at+4);
        if(i.end){ended=true;continue;}
        const flow=i.scalar.name,condition=i.predicate.condition;
        if(flow==="RET" && condition===7)ended=true;
        if(flow==="BRA" || flow==="CAL")
        {
            if(condition!==0)pending.push(i.target);
            if(flow==="CAL" || condition!==7)pending.push(pc+1);
        }
        else if(flow!=="RET" || condition!==7)pending.push(pc+1);
    }
    if(!ended)throw new RangeError("NV40 vertex program has no end instruction");
    return {stage:"vertex",instructions:[...decoded.values()].sort((a,b)=>a.pc-b.pc),entry,word_count:last};
}

export function decode_fragment_program(words,read=null)
{
    const storage=Array.from(words),decoded=new Map(),inline=new Map(),pending=[0];let last=0,ended=false;
    const ensure=count=>{
        if(count>16384)throw new RangeError("NV40 fragment program size");
        while(storage.length<count && read)
        {
            const block=read(storage.length);
            if(!block.length || block.length&3)throw new RangeError("NV40 invalid fragment fetch block");
            storage.push(...block);
        }
        if(storage.length<count)throw new RangeError("NV40 truncated fragment instruction or branch outside program");
    };
    while(pending.length)
    {
        let at=pending.pop();if(decoded.has(at))continue;
        if(at<0 || at&3)throw new RangeError("NV40 invalid fragment branch target");
        ensure(at+4);
        const pc=at, a=storage[at++], b=storage[at++], c=storage[at++], d=storage[at++], branch=!!(c & 0x80000000);
        const opcode=a>>>24&63, input=a>>>13&15;
        const sources = [b,c,d].map((bits,i) => ({type: ["temp","input","constant","invalid"][bits&3],
            index: (bits&3)===1 ? input : bits>>>2&63, swizzle: swizzle(bits,[9,11,13,15]),
            half: !!(bits&256), negate: !!(bits&0x20000), absolute: !!([b>>>29,c>>>18,d>>>18][i]&1)}));
        let constant=-1;
        if(!branch && sources.some(source=>source.type==="constant"))
        {
            try {ensure(at+4);}catch(error){throw new RangeError("NV40 truncated inline fragment constant");}
            inline.set(pc,storage.slice(at,at+4));constant=0;at+=4;
        }
        const instruction={pc,words:[a>>>0,b>>>0,c>>>0,d>>>0],opcode,
            name: branch ? ["BRK","CAL","IF","LOOP","REP","RET"][opcode] || null : FP[opcode] || (opcode===0x3A ? "DIV" : opcode===0x3C ? "LITEX2" : null),
            branch, sources, constant, destination: {index:a>>>1&63,half:!!(a&128),mask:a>>>9&15,disabled:!!(a&0x40000000)},
            precision:a>>>22&3,saturate:!!(a&0x80000000),scale:c>>>28&7,texture:a>>>17&15,
            predicate:{condition:b>>>18&7,swizzle:swizzle(b,[21,23,25,27]),update:!!(a&256),register:b>>>31,destination:b>>>30&1},
            input_relative:!branch && !!(d&0x40000000),address:d>>>19&15,else_offset:c&0x7FFFFFFF,end_offset:d&0x7FFFFFFF,
            loop:{count:c>>>2&255,initial:c>>>10&255,increment:c>>>19&255},
            end:!!(a&1)};
        decoded.set(pc,instruction);last=Math.max(last,at);
        if(instruction.end){ended=true;continue;}
        if(branch && instruction.name==="RET")
        {
            ended=true;if(instruction.predicate.condition===7)continue;
        }
        if(branch && instruction.name==="CAL" && instruction.predicate.condition!==0)pending.push(instruction.else_offset);
        if(branch && ["IF","LOOP","REP"].includes(instruction.name))
        {
            pending.push(instruction.end_offset);
            if(instruction.name==="IF")pending.push(instruction.else_offset);
        }
        pending.push(at);
    }
    if(!ended)throw new RangeError("NV40 fragment program has no end instruction");
    const instructions=[...decoded.values()].sort((a,b)=>a.pc-b.pc),constants=[],normalized=new Uint32Array(last);
    for(const i of instructions)
    {
        if(inline.has(i.pc-4))throw new RangeError("NV40 fragment branch targets an inline constant");
        normalized.set(i.words,i.pc);
        if(inline.has(i.pc)){i.constant=constants.length;constants.push(inline.get(i.pc));}
    }
    return {stage:"fragment",instructions,constants,normalized,word_count:last};
}
