// NV40 decoded straight-line programs -> D3D9 SM3 bytecode. This module only
// emits bytecode; the existing D3D9 pipeline owns WGSL generation and execution.
// Unsupported branches and register aliases fail before any draw.
const OP = {MOV:1,ADD:2,SUB:3,MAD:4,MUL:5,RCP:6,RSQ:7,DP3:8,DP4:9,MIN:10,MAX:11,
    SLT:12,SGE:13,LIT:16,DST:17,FRC:19,DCL:31,SINCOS:37,MOVA:46,DEF:81,
    KIL:65,TEX:66,EX2:14,LG2:15,DDX:91,DDY:92,TXD:93,TXL:95,ABS:35,SGN:34,DP2A:90,CMP:88};
const bits = type => (type & 7) << 28 | (type & 24) << 8;
const dst = (type,index,mask=15,saturate=false,shift=0) =>
    (0x80000000 | bits(type) | index | mask << 16 | +saturate << 20 | shift << 24) >>> 0;
const src = (type,index,swizzle=[0,1,2,3],negate=false,absolute=false) =>
    (0x80000000 | bits(type) | index | swizzle.reduce((a,c,i)=>a|c<<(16+i*2),0) |
        (absolute ? negate ? 12 : 11 : +negate) << 24) >>> 0;
const semantic = (usage,index=0,texture=0) => (0x80000000 | usage | index << 16 | texture << 27) >>> 0;
const VERTEX_OUTPUTS = [[0,0],[10,0],[10,1],[10,2],[10,3],[11,0],[4,0],
    ...Array.from({length:8},(_,i)=>[5,i])];
const FRAGMENT_INPUTS = [[0,0],[10,0],[10,1],[11,0],...Array.from({length:10},(_,i)=>[5,i])];

class Shader
{
    constructor(stage,reserved=[])
    {
        this.stage=stage;this.declarations=[];this.body=[];this.inputs=new Map();this.outputs=new Map();
        this.input_overrides=new Map();this.temps=new Map();this.samplers=new Map();this.constants=new Set(reserved);this.aliases=new Map();this.literals=new Map();
    }
    emit(op,...operands) { this.body.push((operands.length<<24|op)>>>0,...operands); }
    declare(type,index,meaning) { this.declarations.push(0x0200001F,semantic(...meaning),dst(type,index)); }
    temp(key)
    {
        if(!this.temps.has(key))
        {
            if(this.temps.size>=29) throw new RangeError("NV40 straight-line temporary register budget");
            this.temps.set(key,this.temps.size);
        }
        return this.temps.get(key);
    }
    input(index)
    {
        if(this.stage==="fragment" && (index===0 || index===14))
        {
            const special=index===0?0:1;
            if(!this.inputs.has(index)) {this.inputs.set(index,[17,special]);this.declare(17,special,[0,0]);}
        }
        else if(!this.inputs.has(index))
        {
            const meaning=this.stage==="vertex"?[5,index]:FRAGMENT_INPUTS[index];
            if(!meaning || index>=16) throw new RangeError("NV40 unsupported shader input "+index);
            const slot=[...this.inputs.values()].filter(([type])=>type===1).length;
            this.inputs.set(index,[1,slot]);this.declare(1,slot,meaning);
        }
        return this.inputs.get(index);
    }
    output(index)
    {
        if(!this.outputs.has(index))
        {
            if(!VERTEX_OUTPUTS[index] || this.outputs.size>=12) throw new RangeError("NV40 unsupported vertex output "+index);
            const slot=this.outputs.size;this.outputs.set(index,slot);this.declare(6,slot,VERTEX_OUTPUTS[index]);
        }
        return this.outputs.get(index);
    }
    source(source,constant=-1,scalar=false)
    {
        let type,index;
        if(source.type==="temp")
        {
            if(this.stage==="fragment")
            {
                const bank=source.half?"h":"r", base=source.half?source.index>>>1:source.index;
                if(this.aliases.has(base) && this.aliases.get(base)!==bank)
                    throw new RangeError("NV40 mixed half/full register alias needs packing");
            }
            type=0;index=this.temp((source.half?"h":"r")+source.index);
        }
        else if(source.type==="input") [type,index]=this.input_overrides.has(source.index)?[0,this.input_overrides.get(source.index)]:this.input(source.index);
        else if(source.type==="constant")
        {
            type=2;index=this.stage==="fragment"?constant:source.index;
            if(index<0 || index>=(this.stage==="fragment"?224:256)) throw new RangeError("NV40 shader constant limit");
            this.constants.add(index);
        }
        else throw new RangeError("NV40 invalid shader operand");
        const swizzle=scalar?Array(4).fill(source.swizzle[0]):source.swizzle;
        return src(type,index,swizzle,source.negate,source.absolute);
    }
    literal(value)
    {
        if(!this.literals.has(value))
        {
            let index=(this.stage==="vertex"?256:224)-1;
            while(index>=0 && this.constants.has(index))index--;
            if(index<0)throw new RangeError("NV40 arithmetic constant register budget");
            this.constants.add(index);this.literals.set(value,index);
            const word=new Uint32Array(Float32Array.of(value).buffer)[0];
            this.declarations.push(0x05000051,dst(2,index),word,word,word,word);
        }
        return src(2,this.literals.get(value));
    }
    alu(name,destination,sources)
    {
        if(name==="SFL" || name==="STR") {this.emit(OP.MOV,destination,this.literal(name==="STR"?1:0));return;}
        if(name==="SLE" || name==="SGT") {this.emit(name==="SLE"?OP.SGE:OP.SLT,destination,sources[1],sources[0]);return;}
        if(name==="SEQ" || name==="SNE")
        {
            this.emit(OP.SUB,dst(0,29),sources[0],sources[1]);this.emit(OP.ABS,dst(0,29),src(0,29));
            // Equality compares against zero, preserving unordered comparisons.
            if(name==="SEQ")this.emit(OP.SGE,destination,this.literal(0),src(0,29));
            else
            {
                this.emit(OP.SGE,dst(0,29),this.literal(0),src(0,29));
                this.emit(OP.SUB,destination,this.literal(1),src(0,29));
            }
            return;
        }
        if(name==="SSG") {this.emit(OP.SGN,destination,sources[0],sources[0],sources[0]);return;}
        if(name==="DPH")
        {
            this.emit(OP.MOV,dst(0,29),sources[0]);this.emit(OP.MOV,dst(0,29,8),this.literal(1));
            this.emit(OP.DP4,destination,src(0,29),sources[1]);return;
        }
        if(name==="DIV")
        {
            this.emit(OP.RCP,dst(0,29),sources[1]);this.emit(OP.MUL,destination,sources[0],src(0,29));return;
        }
        if(name==="FLR")
        {
            this.emit(OP.FRC,dst(0,29),sources[0]);this.emit(OP.SUB,destination,sources[0],src(0,29));return;
        }
        if(name==="SIN" || name==="COS")
        {
            this.emit(OP.SINCOS,dst(0,29,name==="COS"?1:2),sources[0]);
            this.emit(OP.MOV,destination,src(0,29,Array(4).fill(name==="COS"?0:1)));return;
        }
        const op=OP[name];if(op===undefined) throw new RangeError("NV40 unsupported straight-line opcode "+name);
        this.emit(op,destination,...sources);
    }
    condition(condition,value,target)
    {
        const destination=dst(0,target),zero=this.literal(0);
        if(condition===1)this.emit(OP.SLT,destination,value,zero);
        else if(condition===2 || condition===5)this.alu(condition===2?"SEQ":"SNE",destination,[value,zero]);
        else if(condition===3)this.emit(OP.SGE,destination,zero,value);
        else if(condition===4)this.emit(OP.SLT,destination,zero,value);
        else if(condition===6)this.emit(OP.SGE,destination,value,zero);
        else this.emit(OP.MOV,destination,this.literal(condition===7?1:0));
    }
    finish()
    {
        const bytecode=Uint32Array.from([this.stage==="vertex"?0xFFFE0300:0xFFFF0300,...this.declarations,...this.body,0xFFFF]);
        return {bytecode,inputs:Array.from(this.inputs),outputs:Array.from(this.outputs),samplers:Array.from(this.samplers),
            constants:Array.from(this.constants).sort((a,b)=>a-b)};
    }
}
const arity = name => ["MOV","RCP","RSQ","EX2","LG2","LIT","FRC","FLR","SIN","COS","DDX","DDY","SSG"].includes(name)?1:
    ["MUL","ADD","DP3","DP4","DPH","DST","MIN","MAX","SLT","SGE","SLE","SGT","SEQ","SNE","DIV"].includes(name)?2:
    name==="MAD" || name==="DP2A"?3:0;
const nullary=name=>name==="SFL" || name==="STR";

export function translate_vertex_program(program,options={})
{
    const shader=new Shader("vertex",program.instructions.flatMap(i=>i.sources.filter(s=>s.type==="constant").map(s=>s.index))),raw=new Map();
    const output=index=>{if(!raw.has(index))raw.set(index,shader.temp("output"+index));return raw.get(index);};
    // r29 is arithmetic scratch; r30/r31 retain both VLIW results until both
    // slots have read their operands. Commit vector first, then scalar.
    for(const instruction of program.instructions)
    {
        const i=instruction;
        if(i.predicate.enabled || i.address.input || i.address.constant) throw new RangeError("NV40 vertex predication/relative address needs lowering");
        const slots=[i.vector,i.scalar], results=[];
        for(let slot=0;slot<2;slot++)
        {
            const op=slots[slot];if(op.name==="NOP" || !op.mask) continue;
            const count=arity(op.name);if(!count && !nullary(op.name)) throw new RangeError("NV40 unsupported vertex opcode "+op.name);
            const selectors=slot?[2]:op.name==="ADD"?[0,2]:[0,1,2].slice(0,count);
            const sources=selectors.map(index=>shader.source(i.sources[index],-1,slot===1));
            shader.alu(op.name,dst(0,30+slot,op.mask,i.saturate),sources);
            const index=op.type==="output"?output(op.index):shader.temp("r"+op.index);
            results.push([dst(0,index,op.mask),src(0,30+slot)]);
        }
        for(const operands of results) shader.emit(OP.MOV,...operands);
    }
    const routes=options.result_map || VERTEX_OUTPUTS.map((_,index)=>[index,index,-1,null]);
    for(const [semantic,register,component,enabled]of routes)
    {
        if(enabled===false || !raw.has(register) || semantic===0 && options.viewport)continue;
        shader.emit(OP.MOV,dst(6,shader.output(semantic),component<0?15:1),
            src(0,raw.get(register),component<0?[0,1,2,3]:Array(4).fill(component)));
    }
    const viewport_constants=[];
    if(options.viewport)
    {
        if(!raw.has(0)) throw new RangeError("NV40 vertex position is not written");
        const position=raw.get(0);
        const v=options.viewport,w=v.width,h=v.height;
        if(!(w>0 && h>0)) throw new RangeError("NV40 viewport dimensions");
        const reserve=()=>{
            for(let i=255;i>=0;i--) if(!shader.constants.has(i)) {shader.constants.add(i);return i;}
            throw new RangeError("NV40 viewport constant register budget");
        };
        const scale=reserve(),bias=reserve(),output=dst(6,shader.output(0));
        // Cancel the D3D9 wrapper's half-pixel correction: NV rasterization
        // already has its own pixel-center convention. In bypass mode W is
        // reciprocal homogeneous W, while XYZ are window coordinates.
        const factors=v.bypass?[2/w,-2/h,1,0]:[2*v.scale[0]/w,-2*v.scale[1]/h,v.scale[2],1];
        const offsets=v.bypass?[-1-1/w,1+1/h,0,1]:[2*v.translate[0]/w-1-1/w,1-2*v.translate[1]/h+1/h,v.translate[2],0];
        if(!factors.concat(offsets).every(Number.isFinite)) throw new RangeError("NV40 nonfinite viewport");
        viewport_constants.push([scale,Float32Array.from(factors)],[bias,Float32Array.from(offsets)]);
        if(v.bypass)
        {
            shader.emit(OP.MAD,dst(0,30),src(0,position),src(2,scale),src(2,bias));
            shader.emit(OP.RCP,dst(0,31),src(0,position,[3,3,3,3]));
            shader.emit(OP.MUL,output,src(0,30),src(0,31));
        }
        else
        {
            shader.emit(OP.MUL,dst(0,30),src(0,position),src(2,scale));
            shader.emit(OP.MAD,output,src(0,position,[3,3,3,3]),src(2,bias),src(0,30));
        }
    }
    return {...shader.finish(),viewport_constants};
}

export function translate_fragment_program(program,options={})
{
    const shader=new Shader("fragment",program.constants.map((_,i)=>i));
    // NV fragment FOGC is (coordinate, clamped fog factor, 0, 0), whereas
    // D3D9's FOG varying carries only the coordinate. Generate the factor after
    // interpolation; computing it in the vertex shader changes clamped edges.
    if(program.instructions.some(i=>i.sources.some(s=>s.type==="input" && s.index===3)))
    {
        const [type,index]=shader.input(3),fog=shader.temp("fog"),settings=options.fog || {mode:0x2601,constant:1,linear:1};
        if(![0x2601,0x804,0x800,0x801,0x802,0x803].includes(settings.mode))throw new RangeError("NV40 invalid fog mode");
        if(!Number.isFinite(settings.constant) || !Number.isFinite(settings.linear))throw new RangeError("NV40 nonfinite fog equation");
        shader.emit(OP.MOV,dst(0,fog),shader.literal(0));
        shader.emit(OP.MOV,dst(0,fog,1),src(type,index,[0,0,0,0]));
        const linear=settings.mode===0x2601 || settings.mode===0x804,absolute=[0x804,0x802,0x803].includes(settings.mode);
        shader.emit(OP.MAD,dst(0,fog,2,linear),src(type,index,[0,0,0,0],false,absolute),
            shader.literal(settings.linear),shader.literal(settings.constant-(linear?1:1.5)));
        if(!linear)
        {
            const squared=settings.mode===0x801 || settings.mode===0x803;
            if(squared)shader.emit(OP.MUL,dst(0,fog,2),src(0,fog,[1,1,1,1]),src(0,fog,[1,1,1,1]));
            shader.emit(OP.MUL,dst(0,fog,2),src(0,fog,[1,1,1,1]),shader.literal(squared?-32:16));
            shader.emit(OP.EX2,dst(0,fog,2,true),src(0,fog,[1,1,1,1]));
        }
        shader.input_overrides.set(3,fog);
    }
    const written=new Set(),needsCC=program.instructions.some(i=>i.predicate.update || i.predicate.condition!==7 && i.predicate.condition!==0 || i.name==="KIL");
    const cc=needsCC?shader.temp("cc"):-1;
    if(needsCC)shader.emit(OP.MOV,dst(0,cc),shader.literal(0));
    for(const i of program.instructions)
    {
        if(i.branch || i.input_relative)
            throw new RangeError("NV40 fragment control flow needs lowering");
        if(i.predicate.condition===0 || i.name==="NOP") continue;
        const count=arity(i.name),texture=["TEX","TXP","TXB","TXL","TXD"].includes(i.name);
        if(!count && !texture && i.name!=="KIL" && !nullary(i.name)) throw new RangeError("NV40 unsupported fragment opcode "+i.name);
        const sources=i.sources.slice(0,texture?i.name==="TXD"?3:1:i.name==="KIL"?0:count)
            .map(source=>shader.source(source,i.constant));
        const conditional=i.predicate.condition!==7;
        if(conditional || i.name==="KIL")
        {
            shader.condition(i.predicate.condition,src(0,cc,i.predicate.swizzle),31);
            shader.emit(OP.SUB,dst(0,31),src(0,31),shader.literal(.5));
        }
        if(i.name==="KIL")
        {
            // Native KIL tests the condition code, rather than a source register.
            shader.emit(OP.MOV,dst(0,29),src(0,31,[0,1,2,3],true));shader.emit(OP.KIL,dst(0,29));continue;
        }
        const key=(i.destination.half?"h":"r")+i.destination.index;
        const target=i.destination.disabled?-1:shader.temp(key),staged=conditional || i.predicate.update || i.destination.disabled;
        const shift=i.scale<4?i.scale:8-i.scale+12;
        if(i.scale===4) throw new RangeError("NV40 invalid fragment scale");
        const destination=dst(0,staged?30:target,i.destination.mask,i.saturate,shift);
        if(texture)
        {
            if(!shader.samplers.has(i.texture))
            {
                const dimension=options.samplers?.[i.texture] || 2;
                if(![2,3,4].includes(dimension)) throw new RangeError("NV40 unsupported sampler dimension");
                shader.samplers.set(i.texture,dimension);shader.declare(10,i.texture,[0,0,dimension]);
            }
            const sampler=src(10,i.texture);
            if(i.name==="TXD") shader.emit(OP.TXD,destination,sources[0],sampler,sources[1],sources[2]);
            else shader.emit((i.name==="TXL"?OP.TXL:OP.TEX) | (i.name==="TXP"?1:i.name==="TXB"?2:0)<<16,
                destination,sources[0],sampler);
        }
        else shader.alu(i.name,destination,sources);
        if(staged)
        {
            if(target>=0)
            {
                if(conditional)shader.emit(OP.CMP,dst(0,target,i.destination.mask),src(0,31),src(0,30),src(0,target));
                else shader.emit(OP.MOV,dst(0,target,i.destination.mask),src(0,30));
            }
            if(i.predicate.update)
            {
                if(conditional)shader.emit(OP.CMP,dst(0,cc,i.destination.mask),src(0,31),src(0,30),src(0,cc));
                else shader.emit(OP.MOV,dst(0,cc,i.destination.mask),src(0,30));
            }
        }
        if(target>=0)
        {
            const base=i.destination.half?i.destination.index>>>1:i.destination.index;
            shader.aliases.set(base,i.destination.half?"h":"r");written.add(key);
        }
    }
    if(!written.has((options.fp32_outputs?"r":"h")+"0")) throw new RangeError("NV40 fragment color output is not written");
    for(let color=0;color<(options.targets||1);color++)
    {
        // R1 is reserved for depth. Color 1/2/3 use R2/R3/R4, or their
        // corresponding even half registers H4/H6/H8.
        const register=[0,2,3,4][color],key=(options.fp32_outputs?"r":"h")+(register*(options.fp32_outputs?1:2));
        if(written.has(key)) shader.emit(OP.MOV,dst(8,color),src(0,shader.temp(key)));
    }
    if(options.depth && written.has("r1")) shader.emit(OP.MOV,dst(9,0,1),src(0,shader.temp("r1"),[2,2,2,2]));
    return {...shader.finish(),constant_values:program.constants.map(words=>Uint32Array.from(words))};
}
