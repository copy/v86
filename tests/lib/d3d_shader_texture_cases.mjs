import {dst,src,shader} from "./d3d_shader_cases.mjs";

// Point/clamp sampling of a deliberately asymmetric, exactly representable
// texture. Each mip and cube face is independently distinguishable.
export function texel(x,y,level=0,face=null) {
    return face===null ? [(x+1)/16,(y+1)/16,(level+1)/8,1] : [(face+1)/8,0.25,0.5,1];
}
export function sample(coord,level=0,cube=false) {
    if(cube) {
        const a=coord.map(Math.abs),axis=a.indexOf(Math.max(...a));
        return texel(0,0,0,axis*2+Number(coord[axis]<0));
    }
    const size=8>>level,xy=coord.slice(0,2).map(c=>Math.min(size-1,Math.max(0,Math.floor(c*size))));
    return texel(...xy,level);
}
export function texture_cases() {
    const cases=[],dcl=[[31,0x80000005,dst(1,0)],[31,0x90000000,dst(10,0)]],uv=(x,y)=>[(x+0.5)/8,(y+0.5)/8,0,1];
    const add=(name,body,expected,extra={})=>cases.push({name,tokens:shader("pixel",3,[...dcl,...body]),expected,init:"v0 = vec4<f32>(p.xy / 8.0, 0.0, 1.0);",f:[[0.0625,0.0625,0,1],[0.25,0,0,0],[2,2,2,2]],i:[[3,0,1,0]],...extra});
    const condition=[41|(1<<16),src(1,0,0xff),src(2,1,0xff)],fetch=[66,dst(0,0),src(0,1),src(10,0)];
    add("if-rep-changing-coordinate",[[1,dst(0,1),src(2,0)],condition,[38,src(7,0)],fetch,[2,dst(0,1),src(0,1),src(2,1)],[39],[43]],()=>sample([0.5625,0.0625]));
    add("if-rep-changing-gradient",[[1,dst(0,1),src(1,0)],condition,[38,src(7,0)],fetch,[5,dst(0,1),src(0,1),src(2,2)],[39],[43]],(x,y)=>sample(uv(x,y).map(c=>c*4),2));
    for(const op of [91,92])add("branch-rewritten-derivative-"+op,[condition,[5,dst(0,1),src(1,0),src(2,2)],[op,dst(0,0),src(0,1)],[43]],()=>op===91?[0.25,0,0,0]:[0,0.25,0,0]);
    for(let lod=0;lod<4;lod++) {
        add("explicit-lod-"+lod,[[95,dst(0,0),src(2,0),src(10,0)]],()=>sample([0.5625,0.3125],lod),{f:[[0.5625,0.3125,0,lod]]});
        add("explicit-gradient-"+lod,[[93,dst(0,0),src(2,0),src(10,0),src(2,1),src(2,2)]],()=>sample([0.5625,0.3125],lod),{f:[[0.5625,0.3125,0,0],[2**lod/8,0,0,0],[0,2**lod/8,0,0]]});
        add("implicit-gradient-"+lod,[[5,dst(0,1),src(1,0),src(2,0)],fetch],(x,y)=>sample(uv(x,y).map(c=>c*2**lod),lod),{f:[[2**lod,2**lod,0,1]]});
    }
    add("branch-bias",[condition,[1,dst(0,1),src(1,0)],[1,dst(0,1,8),src(2,2,0)],[66|(2<<16),dst(0,0),src(0,1),src(10,0)],[43]],(x,y)=>sample(uv(x,y),2));
    add("projected",[[66|(1<<16),dst(0,0),src(2,0),src(10,0)]],()=>sample([0.5625,0.3125]),{f:[[1.125,0.625,0,2]]});
    // Source t0 is produced by a real TEX. Test old addressing modifiers with
    // independent dot/matrix/bump equations, including cube face selection.
    const initial=["t0 = vec4<f32>(0.8125,0.3125,0.0,1.0);","t1 = vec4<f32>(1.0,0.0,0.0,1.0);","t2 = vec4<f32>(0.0,1.0,0.0,1.0);","t3 = vec4<f32>(0.0,0.0,1.0,1.0);"];
    for(const modifier of [0,4])for(const kind of ["dp3","dp3tex","m3x2","m3x3","spec","vspec","bem","beml","matrix-result","reg2rgb"]) {
        const value=sample([0.8125,0.3125]).map(x=>modifier===4?2*x-1:x),s=src(3,0,0xe4,modifier),body=[[66,dst(3,0)]];
        let resultIndex=1,expected;
        if(kind==="matrix-result") {
            body.push([73,dst(3,1),s],[73,dst(3,2),s],[86,dst(3,3),s]);resultIndex=3;expected=[...value.slice(0,3),1];
        } else if(kind==="reg2rgb") {body.push([82,dst(3,1),s]);expected=sample(value);}
        else if(kind==="dp3") {body.push([85,dst(3,1),s]);expected=Array(4).fill(value[0]);}
        else if(kind==="dp3tex") {body.push([83,dst(3,1),s]);expected=sample([value[0],0]);}
        else if(kind==="m3x2") {body.push([71,dst(3,1),s],[72,dst(3,2),s]);resultIndex=2;expected=sample(value);}
        else if(["m3x3","spec","vspec"].includes(kind)) {
            body.push([73,dst(3,1),s],[73,dst(3,2),s],[kind==="spec"?76:kind==="vspec"?77:74,dst(3,3),s,...(kind==="spec"?[src(2,0)]:[])]);resultIndex=3;
            let coord=value.slice(0,3);
            if(kind!=="m3x3") {const dot=coord.reduce((a,c)=>a+c,0),length=coord.reduce((a,c)=>a+c*c,0);coord=coord.map(c=>2*c*dot/length-1);}
            expected=sample(coord,0,true);
        } else {
            body.push([kind==="bem"?67:68,dst(3,1),s]);expected=sample([0.5625+value[0]*0.5,0.5625+value[1]*0.5]);
            if(kind==="beml")expected=expected.map((x,c)=>c===3?x:x*Math.min(1,Math.max(0,value[2]*0.5+0.5)));
        }
        body.push([1,dst(0,0),src(3,resultIndex)]);
        cases.push({name:`ps1/${kind}/modifier${modifier}`,tokens:shader("pixel",1,body,["matrix-result","reg2rgb"].includes(kind)?3:1),options:["m3x3","spec","vspec"].includes(kind)?{legacySamplerTypes:{3:"cube"}}:{},f:[[1,1,1,1]],i:[],init:initial.filter((_,i)=>i<=resultIndex).map((line,i)=>i===1&&kind.startsWith("bem")?"t1 = vec4<f32>(0.5625,0.5625,0.0,1.0);":line).join("\n"),expected:()=>expected,bump:[0.5,0,0,0.5],luminance:[0.5,0.5,0,0]});
    }
    for(const kind of ["texdepth","texm3x2depth"])for(const [n,d] of [[0,0],[.25,0],[0,1],[.25,1],[.75,1],[-.25,-1],[.125,.5]]) {
        const body=kind==="texdepth"?[[0xfffd],[87,dst(0,5)]]:[[71,dst(3,1),src(3,0)],[84,dst(3,2),src(3,0)]];
        const init=kind==="texdepth"?`r5 = vec4<f32>(${n},${d},0.0,1.0);`:
            `t0 = vec4<f32>(1.0,0.0,0.0,1.0);t1 = vec4<f32>(${n},0.4,0.7,1.0);t2 = vec4<f32>(${d},0.3,0.8,1.0);`;
        const expected=d===0?1:n/d;
        cases.push({name:`ps1/${kind}/${n}/${d}`,tokens:shader("pixel",1,body,kind==="texdepth"?4:3),init,result:"vec4<f32>(o_depthv.x)",f:[],i:[],expected:()=>Array(4).fill(expected)});
    }
    return cases;
}
