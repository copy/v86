// NV40 decoded programs -> D3D9 SM3 bytecode. This module only emits bytecode;
// the existing D3D9 pipeline owns WGSL generation and execution. Unsupported
// operations fail before any draw.
const OP = {MOV:1,ADD:2,SUB:3,MAD:4,MUL:5,RCP:6,RSQ:7,DP3:8,DP4:9,MIN:10,MAX:11,
    SLT:12,SGE:13,LIT:16,DST:17,FRC:19,DCL:31,SINCOS:37,MOVA:46,DEF:81,
    CALL:25,RET:28,LABEL:30,IFC:41,ELSE:42,ENDIF:43,LOOP:27,ENDLOOP:29,REP:38,ENDREP:39,BREAKC:45,DEFI:48,KIL:65,TEX:66,EX2:14,LG2:15,DDX:91,DDY:92,TXD:93,TXL:95,ABS:35,SGN:34,DP2A:90,CMP:88};
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
        this.input_overrides=new Map();this.temps=new Map();this.samplers=new Map();this.constants=new Set(reserved);this.literals=new Map();
    }
    emit(op,...operands) { const words=operands.flat();this.body.push((words.length<<24|op)>>>0,...words); }
    declare(type,index,meaning) { this.declarations.push(0x0200001F,semantic(...meaning),dst(type,index)); }
    temp(key)
    {
        if(!this.temps.has(key))
        {
            if(this.temps.size>=256) throw new RangeError("NV40 lowered temporary register budget");
            // Reserve r29..31 for ALU/VLIW staging. The shared WGSL translator
            // permits further local registers for NV's larger register files.
            this.temps.set(key,this.temps.size+(this.temps.size>=29?3:0));
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
                index=this.temp("read-"+(source.half?"h":"r")+source.index);
                this.emit(0x1001|+!!source.half<<16,dst(0,index),src(0,source.index));
            }
            else index=this.temp("r"+source.index);
            type=0;
        }
        else if(source.type==="input") [type,index]=this.input_overrides.has(source.index)?[0,this.input_overrides.get(source.index)]:this.input(source.index);
        else if(source.type==="constant")
        {
            type=2;index=this.stage==="fragment"?constant:source.index;
            if(index<0 || index>=(this.stage==="fragment"?224:544)) throw new RangeError("NV40 shader constant limit");
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
            let index=this.stage==="vertex"?544:223;
            while(index>=0 && this.constants.has(index))index+=this.stage==="vertex"?1:-1;
            if(index<0)throw new RangeError("NV40 arithmetic constant register budget");
            this.constants.add(index);this.literals.set(value,index);
            const word=new Uint32Array(Float32Array.of(value).buffer)[0];
            this.declarations.push(0x05000051,dst(2,index),word,word,word,word);
        }
        return src(2,this.literals.get(value));
    }
    alu(name,destination,sources)
    {
        const nvScalar=["RCC","EXP","LOG","LIT","RCP","RSQ","LG2"].indexOf(name);
        if(this.stage==="vertex" && nvScalar>=0)
        {
            this.emit(0x1000|nvScalar<<16,destination,sources[0]);return;
        }
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
        if(name==="LITEX2")
        {
            // Curie's final lighting stage takes the already clamped diffuse
            // term from Y and the logarithmic specular exponent from W.
            const value=this.temp("litex2-source");this.emit(OP.MOV,dst(0,value),sources[0]);
            this.emit(OP.MOV,dst(0,29),this.literal(1));
            this.emit(OP.MOV,dst(0,29,2),src(0,value,[1,1,1,1]));
            this.emit(OP.IFC|1<<16,src(0,value,[1,1,1,1]),this.literal(0));
            this.emit(OP.EX2,dst(0,29,4),src(0,value,[3,3,3,3]));
            this.emit(OP.ELSE);this.emit(OP.MOV,dst(0,29,4),this.literal(0));this.emit(OP.ENDIF);
            this.emit(OP.MOV,destination,src(0,29));return;
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
const arity = name => ["MOV","RCP","RCC","RSQ","EXP","LOG","EX2","LG2","LIT","FRC","FLR","SIN","COS","DDX","DDY","SSG","ARL","ARR",
    "PK2H","PK2US","PK4B","PK4UB","UP2H","UP2US","UP4B","UP4UB","LITEX2"].includes(name)?1:
    ["MUL","ADD","DP3","DP4","DPH","DST","MIN","MAX","SLT","SGE","SLE","SGT","SEQ","SNE","DIV"].includes(name)?2:
    name==="MAD" || name==="DP2A"?3:0;
const nullary=name=>name==="SFL" || name==="STR";

export function translate_vertex_program(program,options={})
{
    const shader=new Shader("vertex",program.instructions.flatMap(i=>i.sources.filter(s=>s.type==="constant").map(s=>s.index))),raw=new Map();
    const vertexTextureConstants=new Map();
    const output=index=>{if(!raw.has(index))raw.set(index,shader.temp("output"+index));return raw.get(index);};
    // TBUF is write only. Keep just results observed by the configured output
    // routing, plus explicit writes; unrouted indexed destinations are dead.
    const indexedTargets=new Set(options.result_map?options.result_map.filter(r=>r[3]!==false).map(r=>r[1]):
        [0,...Array.from({length:8},(_,i)=>7+i)]);
    for(const i of program.instructions)for(const op of [i.vector,i.scalar])
        if(op.type==="output" && !i.address.output)indexedTargets.add(op.index);
    const indexedRegisters=[...indexedTargets].filter(index=>index>=0 && index<16);
    const addresses=new Map();
    const address=register=>{
        if(register>1)throw new RangeError("NV40 invalid address register");
        if(!addresses.has(register))
        {
            const temp=shader.temp("address"+register);addresses.set(register,temp);
            shader.emit(OP.MOV,dst(0,temp),shader.literal(0));
        }
        return addresses.get(register);
    };
    if(program.instructions.some(i=>i.address.input))for(let input=0;input<16;input++)shader.input(input);
    for(const i of program.instructions)
    {
        if(i.address.input || i.address.constant || i.address.output || i.vector.name==="ARA" || i.scalar.name==="PUSHA")address(i.address.register);
        if(["ARL","ARR","ARA"].includes(i.vector.name))address(i.vector.index);
        if(i.scalar.name==="POPA")
        {
            address(i.scalar.index);
            if(i.scalar.mask!==15 || i.predicate.enabled && i.predicate.condition!==7 || i.predicate.update && !i.predicate.vector)
                throw new RangeError("NV40 POPA requires an unconditional full address-register write");
        }
    }
    // The scalar issue slot also contains vector MOV/LIT. Address loads on
    // Curie likewise consume all four source lanes, independently masked.
    const scalarSource=(i,slot)=>slot===1 && !["MOV","LIT"].includes(i.scalar.name);
    const source=(i,operand,slot,index)=>{
        const relative=operand.type==="constant"?i.address.constant:operand.type==="input" && i.address.input;
        if(!relative)return shader.source(operand,-1,scalarSource(i,slot));
        const component=Array(4).fill(i.address.component),last=operand.type==="constant"?543:15;
        shader.emit(OP.ADD,dst(0,29),src(0,address(i.address.register),component),shader.literal(operand.index));
        shader.emit(OP.MAX,dst(0,29),src(0,29),shader.literal(0));
        shader.emit(OP.MIN,dst(0,29),src(0,29),shader.literal(last));
        shader.emit(OP.MOVA,dst(3,0,1),src(0,29));
        const token=shader.source({...operand,index:0},-1,scalarSource(i,slot)),temp=shader.temp("relative"+slot+"-"+index);
        shader.emit(OP.MOV,dst(0,temp),[(token|0x2000)>>>0,src(3,0,[0,0,0,0])]);
        return src(0,temp);
    };
    const conditions=new Map();
    const conditionRegister=register=>{
        if(!conditions.has(register))
        {
            const cc=shader.temp("cc"+register);conditions.set(register,cc);
            shader.emit(OP.MOV,dst(0,cc),shader.literal(0));
        }
        return conditions.get(register);
    };
    // Declare condition storage before any instruction can read or update it.
    for(const i of program.instructions)if(i.predicate.enabled || i.predicate.update || ["BRA","CAL","RET"].includes(i.scalar.name))conditionRegister(i.predicate.register);
    const predicate=program.instructions.some(i=>i.predicate.enabled)?shader.temp("predicate"):-1;
    const flow=program.instructions.some(i=>["BRA","CAL","RET","PUSHA","POPA"].includes(i.scalar.name));
    const outputIndex=program.instructions.some(i=>i.address.output)?shader.temp("outputIndex"):-1;
    let pc=-1,next=-1,stackPointer=-1,branch=-1,pushSource=-1,stack=[],stackKinds=[];
    if(flow)
    {
        pc=shader.temp("pc");next=shader.temp("next");branch=shader.temp("branch");stackPointer=shader.temp("stackPointer");
        stack=Array.from({length:8},(_,i)=>shader.temp("return"+i));
        stackKinds=Array.from({length:8},(_,i)=>shader.temp("stackKind"+i));
        pushSource=shader.temp("pushSource");
        const limit=Math.min(65536,Math.max(1,options.instruction_limit||65536));
        shader.declarations.push(0x05000030,dst(7,0),limit,0,1,0);
        shader.emit(OP.MOV,dst(0,next),shader.literal(program.entry??program.instructions[0].pc));
        shader.emit(OP.MOV,dst(0,stackPointer),shader.literal(0));
        shader.emit(OP.REP,src(7,0,[0,0,0,0]));
        shader.emit(OP.MOV,dst(0,pc),src(0,next));
        shader.emit(OP.BREAKC|4<<16,src(0,pc),shader.literal(0));
    }
    // r29 is arithmetic scratch; r30/r31 retain both VLIW results until both
    // slots have read their operands. Commit vector first, then scalar.
    for(const instruction of program.instructions)
    {
        const i=instruction;
        if(flow)
        {
            shader.emit(OP.IFC|2<<16,src(0,pc),shader.literal(i.pc));
            shader.emit(OP.MOV,dst(0,next),shader.literal(i.end?-1:i.pc+1));
        }
        if(i.predicate.enabled && i.predicate.condition===0)
        {if(flow)shader.emit(OP.ENDIF);continue;}
        const conditional=i.predicate.enabled && i.predicate.condition!==7;
        if(conditional)
        {
            shader.condition(i.predicate.condition,src(0,conditionRegister(i.predicate.register),i.predicate.swizzle),predicate);
            shader.emit(OP.SUB,dst(0,predicate),src(0,predicate),shader.literal(.5));
        }
        if(flow && ["BRA","CAL","RET"].includes(i.scalar.name) && i.predicate.condition!==0 && i.predicate.condition!==7)
        {
            shader.condition(i.predicate.condition,src(0,conditionRegister(i.predicate.register),i.predicate.swizzle),branch);
            shader.emit(OP.MAX,dst(0,branch,1),src(0,branch,[0,0,0,0]),src(0,branch,[1,1,1,1]));
            shader.emit(OP.MAX,dst(0,branch,1),src(0,branch,[0,0,0,0]),src(0,branch,[2,2,2,2]));
            shader.emit(OP.MAX,dst(0,branch,1),src(0,branch,[0,0,0,0]),src(0,branch,[3,3,3,3]));
        }
        if(i.address.output)
        {
            // Both slots share OUT_ADDR and consume the old address register,
            // even if the paired vector instruction loads that register.
            const op=[i.vector,i.scalar].find(op=>op.type==="output");
            if(op)shader.emit(OP.ADD,dst(0,outputIndex),src(0,address(i.address.register),Array(4).fill(i.address.component)),shader.literal(op.index));
        }
        if(i.scalar.name==="PUSHA")shader.emit(OP.MOV,dst(0,pushSource),src(0,address(i.address.register)));
        const slots=[i.vector,i.scalar], results=[];
        for(let slot=0;slot<2;slot++)
        {
            const op=slots[slot];if(op.name==="NOP" || !op.mask || ["BRA","CAL","RET","PUSHA","POPA"].includes(op.name)) continue;
            const count=op.name==="TXL"?1:arity(op.name);if(!count && !nullary(op.name) && op.name!=="ARA") throw new RangeError("NV40 unsupported vertex opcode "+op.name);
            const selectors=slot?[2]:op.name==="ADD"?[0,2]:[0,1,2].slice(0,count);
            const sources=op.name==="ARA"?[]:selectors.map(index=>source(i,i.sources[index],slot,index));
            const addressOp=["ARL","ARR","ARA"].includes(op.name);
            if(op.name==="ARA")
            {
                const register=address(i.address.register);
                shader.emit(OP.ADD,dst(0,30+slot,op.mask),src(0,register,[0,1,0,1]),src(0,register,[2,3,2,3]));
            }
            else if(op.name==="ARL")shader.alu("FLR",dst(0,30+slot,op.mask),sources);
            else if(op.name==="ARR")
            {
                shader.emit(OP.MOVA,dst(3,0,op.mask),sources[0]);
                shader.emit(OP.MOV,dst(0,30+slot,op.mask),src(3,0));
            }
            else if(op.name==="TXL")
            {
                const unit=i.texture,settings=options.vertex_textures?.[unit]||{dimension:2,bias:0,min_lod:0,max_lod:12};
                if(slot || !Number.isInteger(unit) || unit<0 || unit>=4 || ![1,2].includes(settings.dimension))
                    throw new RangeError("NV40 invalid vertex texture instruction");
                if(!vertexTextureConstants.has(unit))
                {
                    let index=544;while(shader.constants.has(index))index++;
                    shader.constants.add(index);vertexTextureConstants.set(unit,[index,
                        Float32Array.of(settings.bias,settings.min_lod,settings.max_lod,0)]);
                    shader.samplers.set(unit,2);shader.declare(10,unit,[0,0,2]);
                }
                const coordinate=shader.temp("vertex-texture-coordinate"),constant=vertexTextureConstants.get(unit)[0];
                shader.emit(OP.MOV,dst(0,coordinate),sources[0]);
                if(settings.dimension===1)shader.emit(OP.MOV,dst(0,coordinate,2),shader.literal(.5));
                shader.emit(OP.ADD,dst(0,coordinate,8),src(0,coordinate),src(2,constant,[0,0,0,0]));
                shader.emit(OP.MAX,dst(0,coordinate,8),src(0,coordinate),src(2,constant,[1,1,1,1]));
                shader.emit(OP.MIN,dst(0,coordinate,8),src(0,coordinate),src(2,constant,[2,2,2,2]));
                shader.emit(OP.TXL,dst(0,30,op.mask,i.saturate),src(0,coordinate),src(10,unit));
                // D3D R32F supplies (R,1,1,1); NV's FLOAT_R expansion is
                // (R,0,0,1). Keep that difference in the NV frontend.
                if(settings.code===28 && op.mask&6)shader.emit(OP.MOV,dst(0,30,op.mask&6),shader.literal(0));
            }
            else shader.alu(op.name,dst(0,30+slot,op.mask,i.saturate),sources);
            if(addressOp)
            {
                shader.emit(OP.MAX,dst(0,30+slot,op.mask),src(0,30+slot),shader.literal(-512));
                shader.emit(OP.MIN,dst(0,30+slot,op.mask),src(0,30+slot),shader.literal(511));
            }
            const relative=!addressOp && op.type==="output" && i.address.output;
            const index=relative?-1:addressOp?address(op.index):op.type==="output"?output(op.index):shader.temp("r"+op.index);
            results.push({index,mask:op.mask,slot,relative});
        }
        for(const {index,mask,slot,relative}of results)
        {
            for(const register of relative?indexedRegisters:[-1])
            {
                const target=relative?output(register):index;
                if(relative)shader.emit(OP.IFC|2<<16,src(0,outputIndex),shader.literal(register));
                if(conditional)shader.emit(OP.CMP,dst(0,target,mask),src(0,predicate),src(0,30+slot),src(0,target));
                else shader.emit(OP.MOV,dst(0,target,mask),src(0,30+slot));
                if(relative)shader.emit(OP.ENDIF);
            }
            // CDST_IS_VEC selects which VLIW result supplies condition codes.
            if(i.predicate.update && slot===(i.predicate.vector?0:1))
            {
                const cc=conditionRegister(i.predicate.register);
                if(conditional)shader.emit(OP.CMP,dst(0,cc,mask),src(0,predicate),src(0,30+slot),src(0,cc));
                else shader.emit(OP.MOV,dst(0,cc,mask),src(0,30+slot));
            }
        }
        if(flow)
        {
            const op=i.scalar.name,condition=i.predicate.condition;
            if(["BRA","CAL","RET"].includes(op) && condition!==0 && !i.end)
            {
                const conditional=condition!==7;
                if(conditional)
                {
                    shader.emit(OP.IFC|1<<16,src(0,branch,[0,0,0,0]),shader.literal(0));
                }
                if(op==="BRA")shader.emit(OP.MOV,dst(0,next),shader.literal(i.target));
                else if(op==="CAL")
                {
                    shader.emit(OP.MOV,dst(0,next),shader.literal(-1));
                    shader.emit(OP.IFC|4<<16,src(0,stackPointer),shader.literal(8));
                    for(let index=0;index<8;index++)
                    {
                        shader.emit(OP.IFC|2<<16,src(0,stackPointer),shader.literal(index));
                        shader.emit(OP.MOV,dst(0,stack[index]),shader.literal(i.pc+1));
                        shader.emit(OP.MOV,dst(0,stackKinds[index]),shader.literal(0));shader.emit(OP.ENDIF);
                    }
                    shader.emit(OP.ADD,dst(0,stackPointer),src(0,stackPointer),shader.literal(1));
                    shader.emit(OP.MOV,dst(0,next),shader.literal(i.target));shader.emit(OP.ENDIF);
                }
                else
                {
                    shader.emit(OP.MOV,dst(0,next),shader.literal(-1));
                    shader.emit(OP.IFC|1<<16,src(0,stackPointer),shader.literal(0));
                    shader.emit(OP.SUB,dst(0,stackPointer),src(0,stackPointer),shader.literal(1));
                    for(let index=0;index<8;index++)
                    {
                        shader.emit(OP.IFC|2<<16,src(0,stackPointer),shader.literal(index));
                        shader.emit(OP.IFC|2<<16,src(0,stackKinds[index]),shader.literal(0));
                        shader.emit(OP.MOV,dst(0,next),src(0,stack[index]));shader.emit(OP.ENDIF);shader.emit(OP.ENDIF);
                    }
                    shader.emit(OP.ENDIF);
                }
                if(conditional)shader.emit(OP.ENDIF);
            }
            if(op==="PUSHA" && !i.end)
            {
                shader.emit(OP.MOV,dst(0,next),shader.literal(-1));
                shader.emit(OP.IFC|4<<16,src(0,stackPointer),shader.literal(8));
                for(let index=0;index<8;index++)
                {
                    shader.emit(OP.IFC|2<<16,src(0,stackPointer),shader.literal(index));
                    shader.emit(OP.MOV,dst(0,stack[index]),src(0,pushSource));
                    shader.emit(OP.MOV,dst(0,stackKinds[index]),shader.literal(1));shader.emit(OP.ENDIF);
                }
                shader.emit(OP.ADD,dst(0,stackPointer),src(0,stackPointer),shader.literal(1));
                shader.emit(OP.MOV,dst(0,next),shader.literal(i.pc+1));shader.emit(OP.ENDIF);
            }
            if(op==="POPA" && !i.end)
            {
                shader.emit(OP.MOV,dst(0,next),shader.literal(-1));
                shader.emit(OP.IFC|1<<16,src(0,stackPointer),shader.literal(0));
                shader.emit(OP.SUB,dst(0,stackPointer),src(0,stackPointer),shader.literal(1));
                for(let index=0;index<8;index++)
                {
                    shader.emit(OP.IFC|2<<16,src(0,stackPointer),shader.literal(index));
                    shader.emit(OP.IFC|2<<16,src(0,stackKinds[index]),shader.literal(1));
                    shader.emit(OP.MOV,dst(0,address(i.scalar.index)),src(0,stack[index]));
                    shader.emit(OP.MOV,dst(0,next),shader.literal(i.pc+1));
                    shader.emit(OP.ENDIF);shader.emit(OP.ENDIF);
                }
                shader.emit(OP.ENDIF);
            }
            shader.emit(OP.ENDIF);
        }
    }
    if(flow)shader.emit(OP.ENDREP);
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
            for(let i=544;i<2048;i++) if(!shader.constants.has(i)) {shader.constants.add(i);return i;}
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
    return {...shader.finish(),viewport_constants,texture_constants:[...vertexTextureConstants.values()]};
}

export function translate_fragment_program(program,options={})
{
    const shader=new Shader("fragment",program.constants.map((_,i)=>i));
    const textureConstants=new Map();
    // The indexed input bank is TEX0..TEX9, independent of other declarations.
    if(program.instructions.some(i=>i.input_relative))for(let index=4;index<14;index++)shader.input(index);
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
    const cc=needsCC?[shader.temp("cc0"),shader.temp("cc1")]:[-1,-1],blocks=[],boundaries=new Set(program.instructions.map(i=>i.pc));
    const flow=program.instructions.some(i=>i.branch),budget=flow?shader.temp("executed"):-1;
    const limit=Math.min(65536,Math.max(1,options.instruction_limit||65536));
    boundaries.add(program.word_count);
    if(needsCC)for(const index of cc)shader.emit(OP.MOV,dst(0,index),shader.literal(0));
    if(flow)shader.emit(OP.MOV,dst(0,budget),shader.literal(0));
    const close=pc=>{
        while(blocks.length && blocks[blocks.length-1].end===pc)
        {
            const block=blocks.pop();shader.emit(block.name==="IF"?OP.ENDIF:block.name==="LOOP"?OP.ENDLOOP:OP.ENDREP);
            if(calls)shader.emit(OP.SUB,dst(0,scopeDepth,block.name==="IF"?2:1),src(0,scopeDepth),shader.literal(1));
        }
        const block=blocks[blocks.length-1];
        if(block?.name==="IF" && block.otherwise===pc && pc!==block.end)shader.emit(OP.ELSE);
    };
    // WGSL forbids recursive functions. Specialize each entry by its bounded
    // hardware call depth; registers and condition codes remain shared globals.
    const calls=program.instructions.some(i=>i.branch && ["CAL","RET"].includes(i.name));
    const scopeDepth=calls?shader.temp("scope-depth"):-1;
    if(calls)shader.emit(OP.MOV,dst(0,scopeDepth),shader.literal(0));
    const loopConstants=new Map(),routines=[],labels=new Map(),functionBodies=[],prefix=shader.body;
    const label=(entry,depth)=>{
        const key=entry+":"+depth;
        if(!labels.has(key)){labels.set(key,routines.length);routines.push({entry,depth,label:routines.length});}
        return labels.get(key);
    };
    const routineInstructions=entry=>{
        const byPC=new Map(program.instructions.map(i=>[i.pc,i])),seen=new Set(),pending=[entry];
        while(pending.length)
        {
            const pc=pending.pop();if(seen.has(pc))continue;
            const i=byPC.get(pc);if(!i)throw new RangeError("NV40 fragment call outside decoded program");
            seen.add(pc);if(i.end || i.branch && i.name==="RET" && i.predicate.condition===7)continue;
            if(i.branch && ["IF","LOOP","REP"].includes(i.name))
            {pending.push(i.end_offset);if(i.name==="IF")pending.push(i.else_offset);}
            pending.push(pc+4+(!i.branch && i.constant>=0?4:0));
        }
        return program.instructions.filter(i=>seen.has(i.pc));
    };
    const terminate=()=>{shader.emit(OP.MOV,dst(0,budget),shader.literal(limit));shader.emit(OP.RET);};
    if(calls){label(program.instructions[0].pc,0);shader.body=[];}
    else routines.push({entry:0,depth:0,label:0});
    for(let routineIndex=0;routineIndex<routines.length;routineIndex++)
    {
    const routine=routines[routineIndex],instructions=calls?routineInstructions(routine.entry):program.instructions;
    if(calls)shader.emit(OP.LABEL,src(18,routine.label));
    for(const i of instructions)
    {
        const readCC=cc[i.predicate.register||0],writeCC=cc[i.predicate.destination||0];
        close(i.pc);
        if(i.branch)
        {
            if(i.name==="CAL" || i.name==="RET")
            {
                if(i.predicate.condition===0)continue;
                const conditional=i.predicate.condition!==7;
                if(conditional)
                {
                    shader.condition(i.predicate.condition,src(0,readCC,i.predicate.swizzle),31);
                    shader.emit(OP.MAX,dst(0,31,1),src(0,31,[0,0,0,0]),src(0,31,[1,1,1,1]));
                    shader.emit(OP.MAX,dst(0,31,1),src(0,31,[0,0,0,0]),src(0,31,[2,2,2,2]));
                    shader.emit(OP.MAX,dst(0,31,1),src(0,31,[0,0,0,0]),src(0,31,[3,3,3,3]));
                    shader.emit(OP.IFC|1<<16,src(0,31,[0,0,0,0]),shader.literal(0));
                }
                if(i.name==="RET")shader.emit(OP.RET);
                else if(routine.depth>=4)terminate();
                else
                {
                    shader.emit(OP.IFC|4<<16,src(0,budget),shader.literal(limit));
                    shader.emit(OP.ADD,dst(0,budget),src(0,budget),shader.literal(1));
                    const savedScope=shader.temp("call-scope-"+routine.depth);
                    shader.emit(OP.MOV,dst(0,savedScope),src(0,scopeDepth));
                    shader.emit(OP.CALL,src(18,label(i.else_offset,routine.depth+1)));
                    shader.emit(OP.MOV,dst(0,scopeDepth),src(0,savedScope));shader.emit(OP.ENDIF);
                }
                if(conditional)shader.emit(OP.ENDIF);
                continue;
            }
            if(i.name==="IF" || i.name==="REP" || i.name==="LOOP")
            {
                if(!boundaries.has(i.end_offset) || i.end_offset<=i.pc || blocks.length && i.end_offset>blocks[blocks.length-1].end)
                    throw new RangeError("NV40 fragment block end outside enclosing scope");
                if(calls)
                {
                    const component=i.name==="IF"?1:0;
                    shader.emit(OP.IFC|3<<16,src(0,scopeDepth,Array(4).fill(component)),shader.literal(component?48:4));
                    shader.emit(OP.MOV,dst(0,budget),shader.literal(limit));shader.emit(OP.ENDIF);
                    shader.emit(OP.ADD,dst(0,scopeDepth,1<<component),src(0,scopeDepth),shader.literal(1));
                }
                if(i.name==="IF")
                {
                    if(!boundaries.has(i.else_offset) || i.else_offset<i.pc+4 || i.else_offset>i.end_offset)
                        throw new RangeError("NV40 fragment ELSE outside block");
                    shader.condition(i.predicate.condition,src(0,readCC,i.predicate.swizzle),31);
                    shader.emit(OP.MAX,dst(0,31,1),src(0,31,[0,0,0,0]),src(0,31,[1,1,1,1]));
                    shader.emit(OP.MAX,dst(0,31,1),src(0,31,[0,0,0,0]),src(0,31,[2,2,2,2]));
                    shader.emit(OP.MAX,dst(0,31,1),src(0,31,[0,0,0,0]),src(0,31,[3,3,3,3]));
                    shader.emit(OP.IFC|1<<16,src(0,31,[0,0,0,0]),shader.literal(0));
                }
                else
                {
                    if(blocks.filter(b=>b.name==="REP" || b.name==="LOOP").length>=4)throw new RangeError("NV40 fragment loop nesting limit");
                    const values=[i.loop.count,i.name==="LOOP"?i.loop.initial:0,i.name==="LOOP"?i.loop.increment:1,0],key=values.join(",");
                    if(!loopConstants.has(key))
                    {
                        loopConstants.set(key,loopConstants.size);
                        shader.declarations.push(0x05000030,dst(7,loopConstants.get(key)),...values);
                    }
                    const register=loopConstants.get(key);
                    if(i.name==="LOOP")shader.emit(OP.LOOP,src(15,0),src(7,register));
                    else shader.emit(OP.REP,src(7,register,[0,0,0,0]));
                    // Charge the implicit ENDREP as well as body instructions;
                    // even deeply nested empty loops have a bounded GPU cost.
                    shader.emit(OP.BREAKC|3<<16,src(0,budget),shader.literal(limit));
                    shader.emit(OP.ADD,dst(0,budget),src(0,budget),shader.literal(1));
                }
                blocks.push({name:i.name,end:i.end_offset,otherwise:i.else_offset});
            }
            else if(i.name==="BRK")
            {
                if(!blocks.some(b=>b.name==="REP" || b.name==="LOOP"))throw new RangeError("NV40 fragment BRK outside loop");
                shader.condition(i.predicate.condition,src(0,readCC,i.predicate.swizzle),31);
                shader.emit(OP.MAX,dst(0,31,1),src(0,31,[0,0,0,0]),src(0,31,[1,1,1,1]));
                shader.emit(OP.MAX,dst(0,31,1),src(0,31,[0,0,0,0]),src(0,31,[2,2,2,2]));
                shader.emit(OP.MAX,dst(0,31,1),src(0,31,[0,0,0,0]),src(0,31,[3,3,3,3]));
                shader.emit(OP.BREAKC|1<<16,src(0,31,[0,0,0,0]),shader.literal(0));
            }
            else throw new RangeError("NV40 fragment control flow needs lowering: "+i.name);
            continue;
        }
        if(i.predicate.condition===0 || i.name==="NOP")
        {if(calls && i.end)terminate();continue;}
        if(flow)
        {
            shader.emit(OP.IFC|4<<16,src(0,budget),shader.literal(limit));
            shader.emit(OP.ADD,dst(0,budget),src(0,budget),shader.literal(1));
        }
        const count=arity(i.name),texture=["TEX","TXP","TXB","TXL","TXD"].includes(i.name);
        if(!count && !texture && i.name!=="KIL" && !nullary(i.name)) throw new RangeError("NV40 unsupported fragment opcode "+i.name);
        const sources=i.sources.slice(0,texture?i.name==="TXD"?3:1:i.name==="KIL"?0:count)
            .map(source=>{
                if(!i.input_relative || source.type!=="input")return shader.source(source,i.constant);
                if(!blocks.some(b=>b.name==="LOOP"))throw new RangeError("NV40 relative fragment input outside LOOP");
                const token=shader.source({...source,index:4},i.constant);
                return [(token|0x2000|i.address)>>>0,src(15,0,[0,0,0,0])];
            });
        const conditional=i.predicate.condition!==7;
        if(conditional || i.name==="KIL")
        {
            shader.condition(i.predicate.condition,src(0,readCC,i.predicate.swizzle),31);
            shader.emit(OP.SUB,dst(0,31),src(0,31),shader.literal(.5));
        }
        if(i.name==="KIL")
        {
            // Native KIL tests the condition code, rather than a source register.
            shader.emit(OP.MOV,dst(0,29),src(0,31,[0,1,2,3],true));shader.emit(OP.KIL,dst(0,29));
            if(flow)shader.emit(OP.ENDIF);if(calls && i.end)terminate();continue;
        }
        const half=!!i.destination.half,base=half?i.destination.index>>>1:i.destination.index;
        const pack=["PK2H","PK2US","PK4B","PK4UB"].indexOf(i.name),unpack=["UP2H","UP2US","UP4B","UP4UB"].indexOf(i.name);
        if(pack>=0)
        {
            if(half || i.scale || i.saturate || i.predicate.update)throw new RangeError("NV40 pack requires an unmodified full register destination");
            if(!i.destination.disabled)
            {
                shader.emit(0x1005|pack<<16,dst(0,i.destination.index,i.destination.mask),sources[0],conditional?src(0,31):shader.literal(1));
                written.add(base);
            }
            if(flow)shader.emit(OP.ENDIF);if(calls && i.end)terminate();continue;
        }
        const shift=i.scale<4?i.scale:8-i.scale+12;
        if(i.scale===4) throw new RangeError("NV40 invalid fragment scale");
        const copy=i.name==="MOV" && i.sources[0].type==="temp" && !!i.sources[0].half===half && !i.scale && !i.saturate;
        const destination=dst(0,30,i.destination.mask,i.saturate,shift);
        if(texture)
        {
            const size=options.texture_sizes?.[i.texture];
            if(size)
            {
                if(size.some(value=>!Number.isInteger(value) || value<=0 || value>4096))throw new RangeError("NV40 unnormalized texture dimensions");
                if(!textureConstants.has(i.texture))
                {
                    let index=223;while(index>=0 && shader.constants.has(index))index--;
                    if(index<0)throw new RangeError("NV40 texture coordinate constant budget");
                    shader.constants.add(index);textureConstants.set(i.texture,[index,Float32Array.of(1/size[0],1/size[1],1/size[2],1)]);
                }
                const index=textureConstants.get(i.texture)[0];
                for(let operand=0;operand<(i.name==="TXD"?3:1);operand++)
                {
                    const temp=shader.temp("texture-coordinate-"+operand);
                    shader.emit(OP.MUL,dst(0,temp),sources[operand],src(2,index));sources[operand]=src(0,temp);
                }
            }
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
        else if(unpack>=0)
        {
            const source=i.sources[0],physical=source.type==="temp";
            if(physical && source.half)throw new RangeError("NV40 unpack requires a full register source");
            const token=physical?src(0,source.index,source.swizzle,source.negate,source.absolute):sources[0];
            shader.emit(0x1006|(unpack|+physical<<2)<<16,destination,token);
        }
        else if(!copy)shader.alu(i.name,destination,sources);
        if(!i.destination.disabled)
        {
            const predicate=conditional?src(0,31):shader.literal(1);
            if(copy)
            {
                const source=i.sources[0];
                shader.emit(0x1004|+half<<16,dst(0,i.destination.index,i.destination.mask),
                    src(0,source.index,source.swizzle,source.negate,source.absolute),predicate);
            }
            else shader.emit(0x1002|+half<<16,dst(0,i.destination.index,i.destination.mask),src(0,30),predicate);
            written.add(base);
        }
        if(i.predicate.update)
        {
            // CREG observes the rounded destination precision, including
            // underflow to signed zero, even for a disabled result register.
            if(copy)shader.emit(OP.MOV,dst(0,30,i.destination.mask),sources[0]);
            if(half)shader.emit(0x1003,dst(0,30,i.destination.mask),src(0,30));
            if(conditional)shader.emit(OP.CMP,dst(0,writeCC,i.destination.mask),src(0,31),src(0,30),src(0,writeCC));
            else shader.emit(OP.MOV,dst(0,writeCC,i.destination.mask),src(0,30));
        }
        if(flow)shader.emit(OP.ENDIF);
        if(calls && i.end)terminate();
    }
    close(program.word_count);
    if(blocks.length)throw new RangeError("NV40 unterminated fragment block");
    if(calls){shader.emit(OP.RET);for(const word of shader.body)functionBodies.push(word);shader.body=[];}
    }
    if(calls){shader.body=prefix;shader.emit(OP.CALL,src(18,0));}
    if(calls)written.add(0); // Unwritten result registers are undefined; choose zero.
    if(!written.has(0)) throw new RangeError("NV40 fragment color output is not written");
    for(let color=0;color<(options.targets||1);color++)
    {
        // R1 is reserved for depth. Color 1/2/3 use R2/R3/R4, or their
        // corresponding even half registers H4/H6/H8.
        const register=[0,2,3,4][color];
        if(written.has(register)) shader.emit(OP.MOV,dst(8,color),shader.source({type:"temp",index:register*(options.fp32_outputs?1:2),
            half:!options.fp32_outputs,swizzle:[0,1,2,3]}));
    }
    if(options.depth && written.has(1)) shader.emit(OP.MOV,dst(9,0,1),shader.source({type:"temp",index:1,half:false,swizzle:[2,2,2,2]}));
    if(calls){shader.emit(OP.RET);shader.body=shader.body.concat(functionBodies);}
    return {...shader.finish(),constant_values:program.constants.map(words=>Uint32Array.from(words)),texture_constants:[...textureConstants.values()]};
}
