// Small bytecode builder and deterministic numerical cases. No guest assets.
export const dst = (type,index,mask=15,modifier=0,shift=0) => (0x80000000|((type&7)<<28)|((type&24)<<8)|index|(mask<<16)|(modifier<<20)|(shift<<24))>>>0;
export const src = (type,index,swizzle=0xe4,modifier=0,relative=false) => (0x80000000|((type&7)<<28)|((type&24)<<8)|index|(swizzle<<16)|(modifier<<24)|(relative?8192:0))>>>0;
export function shader(kind,major,body,minor=major===1?1:0) {
    const out=[(kind==="vertex"?0xfffe0000:0xffff0000)|(major<<8)|minor];
    for(const [code,...args] of body)out.push(code|(major>=2?args.length<<24:0),...args);
    out.push(0xffff);return new Uint32Array(out);
}
export function numerical_cases() {
    const cases=[];
    // Legal arithmetic families, with source and destination modifiers sampled
    // separately so a mismatch can be attributed to one operation.
    const arities={1:1,2:2,3:2,4:3,5:2,6:1,7:1,8:2,9:2,10:2,11:2,12:2,13:2,14:1,15:1,16:1,17:2,18:3,19:1,32:2,33:2,34:3,35:1,36:1,37:1,78:1,79:1,88:3,90:3};
    for(const kind of ["vertex","pixel"])for(const major of [1,2,3]) {
        for(const [number,arity] of Object.entries(arities)) {
            const code=+number;
            // These are common ALU tests, not a shader validator acceptance matrix.
            if(major===1 && ![1,2,3,4,5,6,7,8,9,10,11,12,13,16,17,18,19,78,79].includes(code))continue;
            if(kind==="pixel"&&major===1&&![1,2,3,4,5,8,18].includes(code))continue;
            if(code===37&&major<3)continue;
            for(const mask of code===37?[1,3]:[15,5]) {
                const args=Array.from({length:arity},(_,n)=>src(2,n,[6,7,14,15,32,37,78,79].includes(code)?0:0xe4));
                cases.push({name:`${kind}${major}/op${code}/mask${mask}`,absoluteTolerance:code===37?2**-11:0,tokens:shader(kind,major,[[1,dst(0,0),src(2,3)],[code,dst(0,0,mask),...args]])});
            }
        }
        const mods=major===1?(kind==="pixel"?[0,1,2,3,4,5,6]:[0,1]):[0,1,11,12];
        for(const modifier of mods)for(const swizzle of [0xe4,0x1b,0,0xff])for(const mask of [1,3,7,15]) {
            cases.push({name:`${kind}${major}/mov/mod${modifier}/sw${swizzle}/mask${mask}`,tokens:shader(kind,major,[[1,dst(0,0),src(2,3)],[1,dst(0,0,mask),src(2,0,swizzle,modifier)]])});
        }
    }
    for(const major of [2,3]) {
        const rel=src(2,0,0xe4,0,true), al=src(15,0,0);
        // The outer counter must resume after a nested loop or early break.
        for(const early of [false,true])cases.push({name:`vs${major}/nested-loop/break${early}`,tokens:shader("vertex",major,[
            [1,dst(0,0),src(2,3)], [27,al,src(7,0)], [2,dst(0,0),src(0,0),rel,al],
            [27,al,src(7,1)], [2,dst(0,0),src(0,0),rel,al], ...(early?[[44]]:[]), [29],
            [2,dst(0,0),src(0,0),rel,al], [29]
        ])});
    }
    for(const major of [1,2,3])cases.push({name:`vs${major}/address-rounding`,tokens:shader("vertex",major,[
        [major===1?1:46,dst(3,0,1),src(2,0,0)],
        [1,dst(0,0),src(2,3,0xe4,0,true),...(major===1?[]:[src(3,0,0)])]
    ])});
    for(const major of [2,3]) {
        const rel=src(2,0,0xe4,0,true),al=src(15,0,0);
        cases.push({name:`vs${major}/loop-call-return`,tokens:shader("vertex",major,[
            [1,dst(0,0),src(2,3)],[27,al,src(7,0)],[25,src(18,0)],
            [2,dst(0,0),src(0,0),rel,al],[29],[28],[30,src(18,0)],
            [27,al,src(7,1)],[2,dst(0,0),src(0,0),rel,al],[28],[29],[28]
        ])});
        cases.push({name:`vs${major}/if-loop-break`,tokens:shader("vertex",major,[
            [1,dst(0,0),src(2,3)],[40,src(14,0)],[27,al,src(7,0)],
            [2,dst(0,0),src(0,0),rel,al],[44],[29],[42],[1,dst(0,0),src(2,1)],[43]
        ])});
    }
    for(const shift of [1,2,3,13,14,15])for(const mask of [5,15])cases.push({name:`ps14/shift${shift}/mask${mask}`,tokens:shader("pixel",1,[
        [1,dst(0,0),src(2,3)],[2,dst(0,0,mask,1,shift),src(2,0),src(2,1)]
    ],4)});
    for(const kind of ["vertex","pixel"])for(const major of [2,3])cases.push({name:`${kind}${major}/pow-zero-exponent`,tokens:shader(kind,major,[[32,dst(0,0),src(2,0,0),src(2,0,0)]])});
    // Non-replicated legacy operands distinguish x from w. Non-unit inputs
    // also distinguish LOGP's replicated logarithm from a mantissa/exponent
    // tuple, which Wine visual's input w=2 cannot distinguish.
    for(const code of [6,7,14,15,78,79])for(const swizzle of [0xe4,0x1b])for(const mask of [15,5])
        cases.push({name:`vs1/scalar${code}/sw${swizzle}/mask${mask}`,tokens:shader("vertex",1,[
            [1,dst(0,0),src(2,3)],[code,dst(0,0,mask),src(2,0,swizzle)]])});
    return cases;
}
export function numerical_inputs(count=32) {
    let seed=0x395d2b71;
    const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/0x100000000;};
    const edges=[-2.4,-1.6,-1,-0.5,-0.4,-0.001,0,0.001,0.4,0.5,1,1.6,2.4];
    return Array.from({length:count},(_,caseIndex)=>({
        f:Array.from({length:8},(_,register)=>Array.from({length:4},(_,channel)=>Math.fround(caseIndex<edges.length?edges[(caseIndex+register+channel)%edges.length]:(random()*4-2)))),
        i:[[3,0,1,0],[2,4,1,0]],b:[true,false]
    }));
}
