// Numerical oracle for SM1–3. It consumes decoded operands, never generated
// WGSL. Operation equations follow Microsoft's Direct3D assembly reference:
// https://learn.microsoft.com/windows/win32/direct3dhlsl/dx9-graphics-reference-asm
// vs_1_1 MOV address rounding follows Wine visual.c test_mova's Windows
// observations (floor), which disagree with the current mov-vs documentation.
const f32 = Math.fround, maximum = f32(3.4028234663852886e38);
// MOVA says nearest; the numerical fixture selects ties-to-even. This is
// distinct from vs_1_1 MOV's Windows-observed floor conversion.
const nearest = x => {const lo=Math.floor(x),fraction=x-lo;return fraction===0.5 ? lo+(Math.abs(lo)%2) : Math.floor(x+0.5);};
const vector = (x = 0) => [x, x, x, x];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const compare = (mode, a, b) => {
    switch(mode) {
    case 1: return a > b; case 2: return a === b; case 3: return a >= b;
    case 4: return a < b; case 5: return a !== b; case 6: return a <= b;
    default: throw new Error("Unknown comparison " + mode);
    }
};
export function execute_shader(parsed, input = {}, limit = 100000) {
    const registers = new Map(), constants = new Map(), integers = new Map(), booleans = new Map();
    const key = (type, index) => type + ":" + index;
    for(const [index, value] of Object.entries(input.f || [])) constants.set(+index, value.map(f32));
    for(const [index, value] of Object.entries(input.i || [])) integers.set(+index, value.map(x => x | 0));
    for(const [index, value] of Object.entries(input.b || [])) booleans.set(+index, vector(Number(!!value)));
    for(const [index, value] of Object.entries(input.v || [])) registers.set(key(1, +index), value.map(f32));
    for(const [index, value] of Object.entries(input.t || [])) registers.set(key(3, +index), value.map(f32));
    let loopValue = 0, killed = false, steps = 0;
    const instructions = parsed.instructions, labels = new Map(), ends = new Map(), alternatives = new Map(), blocks = [];
    for(let pc = 0; pc < instructions.length; ++pc) {
        const op = instructions[pc];
        if(op.opcode === 81) constants.set(op.dest.index, op.literals.map(f32));
        if(op.opcode === 48) integers.set(op.dest.index, op.literals.slice());
        if(op.opcode === 47) booleans.set(op.dest.index, vector(Number(op.literals[0])));
        if(op.opcode === 30) labels.set(op.sources[0].index, pc + 1);
        if([27, 38, 40, 41].includes(op.opcode)) blocks.push(pc);
        if(op.opcode === 42) alternatives.set(blocks[blocks.length - 1], pc);
        if([29, 39, 43].includes(op.opcode)) {
            const start = blocks.pop();
            if(start === undefined) throw new Error("Unbalanced shader flow");
            ends.set(start, pc); if(alternatives.has(start)) ends.set(alternatives.get(start), pc);
        }
    }
    if(blocks.length) throw new Error("Unclosed shader flow");
    function raw(operand) {
        let index = operand.index;
        if(operand.relative) {
            const token = operand.relativeToken;
            const type = token ? ((token >>> 28) & 7) | ((token >>> 8) & 24) : 3;
            const component = token ? (token >>> 16) & 3 : 0;
            index += raw({type,index:token & 0x7ff})[component];
        }
        if(operand.type === 2) {
            const value = constants.get(index) || vector();
            return parsed.kind === "pixel" && parsed.major === 1 ? value.map(x => clamp(x, -1, 1)) : value;
        }
        if(operand.type === 7) return integers.get(index) || vector();
        if(operand.type === 14) return booleans.get(index) || vector();
        if(operand.type === 15) return vector(loopValue);
        return registers.get(key(operand.type, index)) || vector();
    }
    function source(operand) {
        const value = raw(operand), sw = operand.swizzle ?? 0xe4;
        const v = Array.from({length:4}, (_, c) => value[(sw >> (2 * c)) & 3]);
        switch(operand.modifier || 0) {
        case 0: return v; case 1: return v.map(x => -x);
        case 2: return v.map(x => f32(x - 0.5)); case 3: return v.map(x => -f32(x - 0.5));
        case 4: return v.map(x => f32(2 * x - 1)); case 5: return v.map(x => -f32(2 * x - 1));
        case 6: return v.map(x => f32(1 - x)); case 7: return v.map(x => f32(2 * x));
        case 8: return v.map(x => f32(-2 * x)); case 9: return v.map(x => f32(x / v[2]));
        case 10: return v.map(x => f32(x / v[3])); case 11: return v.map(Math.abs);
        case 12: return v.map(x => -Math.abs(x)); case 13: return v.map(x => Number(!x));
        default: throw new Error("Unknown source modifier " + operand.modifier);
        }
    }
    function store(op, value) {
        const dest = op.dest, name = key(dest.type, dest.index), old = registers.get(name) || vector();
        const predicate = op.predicated ? source(op.predicate) : vector(1);
        const shift = dest.shift > 7 ? dest.shift - 16 : dest.shift || 0;
        for(let c = 0; c < 4; ++c) if((dest.writeMask & (1 << c)) && predicate[c]) {
            let x = f32(value[c] * 2 ** shift);
            if(dest.modifier & 1) x = clamp(x, 0, 1);
            if(dest.type === 3 && parsed.kind === "vertex") x = op.opcode === 1 && parsed.major === 1
                ? Math.floor(x) : nearest(x);
            old[c] = x;
        }
        registers.set(name, old);
    }
    const loops = [], calls = [];
    function leaveLoop() {
        const frame = loops.pop();
        if(!frame) throw new Error("Break outside loop");
        if(frame.kind === 27) loopValue = frame.saved;
        return frame.end;
    }
    for(let pc = 0; pc < instructions.length; ++pc) {
        if(++steps > limit) throw new Error("Shader reference instruction budget exceeded");
        const op = instructions[pc], code = op.opcode;
        if([0, 31, 47, 48, 81, 0xfffd].includes(code)) continue;
        if(code === 30) break; // labelled subroutines are called, never fall through
        if(code === 25 || code === 26) {
            if(code === 25 || source(op.sources[1])[0]) {
                const target = labels.get(op.sources[0].index);
                if(target === undefined || calls.length > 32) throw new Error("Invalid shader call");
                calls.push({pc,depth:loops.length,loopValue});pc = target - 1;
            }
            continue;
        }
        if(code === 28) {
            if(!calls.length) break;
            const frame = calls.pop();loops.length = frame.depth;loopValue = frame.loopValue;pc = frame.pc;continue;
        }
        if(code === 40 || code === 41) {
            const condition = code === 40 ? !!source(op.sources[0])[0] : compare(op.control, source(op.sources[0])[0], source(op.sources[1])[0]);
            if(!condition) pc = alternatives.get(pc) ?? ends.get(pc);
            continue;
        }
        if(code === 42) {pc = ends.get(pc);continue;}
        if(code === 43) continue;
        if(code === 27 || code === 38) {
            const params = source(op.sources[code === 27 ? 1 : 0]), end = ends.get(pc);
            if(params[0] <= 0) {pc = end;continue;}
            loops.push({kind:code,start:pc,end,count:params[0],step:params[2],saved:loopValue});
            if(code === 27) loopValue = params[1];
            continue;
        }
        if(code === 29 || code === 39) {
            const frame = loops[loops.length - 1];
            if(--frame.count > 0) {if(code === 29) loopValue += frame.step;pc = frame.start;}
            else leaveLoop();
            continue;
        }
        if(code === 44 || code === 45 || code === 96) {
            if(code === 44 || (code === 96 ? !!source(op.sources[0])[0] : compare(op.control, source(op.sources[0])[0], source(op.sources[1])[0]))) pc = leaveLoop();
            continue;
        }
        const s = op.sources.map(source), a = s[0], b = s[1], c = s[2];
        // Native VS1.x scalar operands select w after the source swizzle.
        const scalar = a?.[parsed.kind === "vertex" && parsed.major === 1 ? 3 : 0];
        const each = fn => Array.from({length:4}, (_, n) => fn(n));
        const dot = (x,y,n) => {let sum=0;for(let j=0;j<n;j++) sum=f32(sum+f32(x[j]*y[j]));return sum;};
        let value;
        switch(code) {
        case 1: case 46: value=a;break;
        case 2: value=each(n=>a[n]+b[n]);break;
        case 3: value=each(n=>a[n]-b[n]);break;
        case 4: value=each(n=>f32(a[n]*b[n])+c[n]);break;
        case 5: value=each(n=>a[n]*b[n]);break;
        case 6: value=vector(scalar===0?maximum:1/scalar);break;
        case 7: value=vector(scalar===0?maximum:1/Math.sqrt(Math.abs(scalar)));break;
        case 8: case 9: value=vector(dot(a,b,code===8?3:4));break;
        case 10: value=each(n=>Math.min(a[n],b[n]));break;
        case 11: value=each(n=>Math.max(a[n],b[n]));break;
        case 12: value=each(n=>Number(a[n]<b[n]));break;
        case 13: value=each(n=>Number(a[n]>=b[n]));break;
        case 14: value=vector(2**scalar);break;
        case 15: case 79: value=vector(scalar===0?-maximum:Math.log2(Math.abs(scalar)));break;
        case 16: value=[1,Math.max(0,a[0]),a[0]>0&&a[1]>0?Math.pow(a[1],clamp(a[3],-127.9961,127.9961)):0,1];break;
        case 17: value=[1,a[1]*b[1],a[2],b[3]];break;
        case 18: value=each(n=>f32(a[n]*b[n])+f32((1-a[n])*c[n]));break;
        case 19: value=a.map(x=>x-Math.floor(x));break;
        case 20: case 21: case 22: case 23: case 24: {
            const sizes={20:[4,4],21:[4,3],22:[3,4],23:[3,3],24:[3,2]},[cols,rows]=sizes[code];value=vector();
            for(let row=0;row<rows;row++)value[row]=dot(a,source({...op.sources[1],index:op.sources[1].index+row}),cols);
            break;
        }
        case 32: value=vector(Math.pow(Math.abs(a[0]),b[0]));break;
        case 33: value=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0],0];break;
        case 34: value=a.map(Math.sign);break;
        case 35: value=a.map(Math.abs);break;
        case 36: {const len=Math.hypot(...a.slice(0,3));value=len?[a[0]/len,a[1]/len,a[2]/len,0]:vector();break;}
        case 37: value=[Math.cos(a[0]),Math.sin(a[0]),0,0];break;
        case 65: if(raw(op.dest).slice(0,3).some(x=>x<0))killed=true;continue;
        case 78: value=parsed.major===1?[2**Math.floor(scalar),scalar-Math.floor(scalar),2**scalar,1]:vector(2**scalar);break;
        case 80: value=each(n=>a[n]>0.5?b[n]:c[n]);break;
        case 88: value=each(n=>a[n]>=0?b[n]:c[n]);break;
        case 90: value=vector(f32(dot(a,b,2)+c[0]));break;
        case 94: value=each(n=>Number(compare(op.control,a[n],b[n])));break;
        default: throw new Error("Reference opcode not implemented: " + code);
        }
        store(op,value);
    }
    return {registers,steps,killed,read:(type,index)=> (registers.get(key(type,index)) || vector()).slice()};
}
