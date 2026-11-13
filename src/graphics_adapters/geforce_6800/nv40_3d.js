import {decode_vertex_program,decode_fragment_program} from "./nv40_program.js";
import {translate_vertex_program,translate_fragment_program} from "./nv40_shader.js";
import {NV40State} from "./nv40_state.js";
import {NV40Render} from "./nv40_render.js";
// NV40_3D control state. Method layouts: envytools rnndb/graph/nv30-40_3d.xml
// and hwtest/pgraph_class_kelvin.cc (MIT). This implementation is original.
// Draw, query and clear triggers are deliberately outside the state whitelist.
const STATE_RANGES = [
    [0x180, 0x1B8],
    [0x200, 0x22C],
    [0x234, 0x23C],
    [0x260, 0x264],
    [0x280, 0x28C],
    [0x2B8, 0x38C],
    [0x394, 0x398],
    [0x3B0, 0x3B0],
    [0x3B8, 0x3BC],
    [0x8C0, 0x8C4],
    [0x8CC, 0x8D8],
    [0x8E0, 0x8E4],
    [0x900, 0x91C],
    [0xA00, 0xA04],
    [0xA0C, 0xA0C],
    [0xA1C, 0xA3C],
    [0xA60, 0xB0C],
    [0xB40, 0xB5C],
    [0xB80, 0xBFC],
    [0x1428, 0x1430],
    [0x1438, 0x1438],
    [0x1450, 0x1454],
    [0x145C, 0x145C],
    [0x1478, 0x1508],
    [0x1510, 0x1518],
    [0x1520, 0x1528],
    [0x1530, 0x1538],
    [0x1540, 0x1548],
    [0x1550, 0x1558],
    [0x1560, 0x1568],
    [0x1570, 0x1578],
    [0x1580, 0x1588],
    [0x1590, 0x1598],
    [0x15A0, 0x15A8],
    [0x15B0, 0x15B8],
    [0x15C0, 0x15C8],
    [0x15D0, 0x15D8],
    [0x15E0, 0x15E8],
    [0x15F0, 0x15F8],
    [0x1680, 0x16BC],
    [0x1710, 0x171C],
    [0x1738, 0x177C],
    [0x1804, 0x1804],
    [0x181C, 0x1820],
    [0x1828, 0x185C],
    [0x1880, 0x1AFC],
    [0x1C00, 0x1D00],
    [0x1D60, 0x1D64],
    [0x1D6C, 0x1D6C],
    [0x1D78, 0x1D90],
    [0x1D98, 0x1D9C],
    [0x1DA4, 0x1DC0],
    [0x1E40, 0x1E7C],
    [0x1E94, 0x1EA4],
    [0x1EE0, 0x1F7C],
    [0x1FC0, 0x1FE0],
    [0x1FF0, 0x1FF8],
];
const get = (o, at) => o.methods.get(at) || 0;
// Private decoded state keys live outside the guest's 8 KiB method window.
const VP_CODE = 0x10000, VP_CONSTANTS = 0x20000, VP_WORD = 0x30000, CONST_WORD = 0x30004, PRIMITIVE = 0x50000;

export class NV40_3D
{
    constructor(graph) { this.graph = graph; this.device = graph.device; this.captured = new Map(); this.state = new NV40State(this.device); this.backend = this.device.renderer ? new NV40Render(this,this.device.renderer) : null; }
    get busy() {return !!(this.backend && this.backend.pending);}
    method(o, at, value, subc=0)
    {
        if(at & 3 || o.class_id !== 0x4097) return false;
        if(at===0x1808 && value && this.device.trace.enabled)
        {
            const program=this.program(o), key=JSON.stringify([program.vertex,program.fragment && program.fragment.normalized]);
            if(!this.captured.has(key) && this.captured.size>=64) this.captured.delete(this.captured.keys().next().value);
            this.captured.set(key,program);
        }
        if(this.backend && at===0x1808)
        {
            if(value)
            {
                if(value>10 || get(o,PRIMITIVE)) throw new RangeError("NV40 nested/invalid BEGIN");
                o.methods.set(PRIMITIVE,value);o.stream=[];
            }
            else
            {
                const mode=get(o,PRIMITIVE);
                if(!mode) throw new RangeError("NV40 END without BEGIN");
                const words=o.stream;
                o.methods.delete(PRIMITIVE);o.stream=[];
                if(words.length) this.backend.draw(o,mode,words,null,subc);
            }
            return true;
        }
        if(this.backend && at===0x1818)
        {
            if(!get(o,PRIMITIVE) || o.stream.length>=1<<20) throw new RangeError("NV40 invalid inline vertex stream");
            o.stream.push(value>>>0);return true;
        }
        if(at === 0x1D70)
        {
            const offset = get(o, 0x1D6C);
            if(offset & ~0xFF0) throw new RangeError("NV40 fence selector is not implemented");
            if(!o.methods.has(0x1A4)) throw new RangeError("NV40 fence DMA unbound");
            const dma = this.device.dma.descriptor(get(o, 0x1A4) * 16), bytes = new Uint8Array(4);
            if(dma.adjust) throw new RangeError("NV40 fence DMA must be page aligned");
            new DataView(bytes.buffer).setUint32(0, value, true);
            this.device.dma.write(dma, offset, bytes);
            return true;
        }
        if(!STATE_RANGES.some(([first, last]) => at >= first && at <= last) && !(at >= 0x1B00 && at <= 0x1BFC)) return false;
        if(at === 0x1D6C && (value & ~0x0F000FF0 || (value >>> 24) > 4)) throw new RangeError("NV40 invalid fence offset");
        if([0x1E9C, 0x1EA0, 0x1EFC].includes(at) && value >= 0x220) throw new RangeError("NV40 invalid vertex program address");
        if(at === 0x1E9C) o.methods.set(VP_WORD, value);
        else if(at === 0x1EFC) o.methods.set(CONST_WORD, value);
        else if(at >= 0xB80 && at <= 0xBFC)
        {
            const cursor = get(o, VP_WORD);
            if(cursor >= 0x220) throw new RangeError("NV40 vertex program upload overflow");
            o.methods.set(VP_CODE + cursor * 16 + (at & 12), value >>> 0);
            if((at & 12) === 12) o.methods.set(VP_WORD, cursor + 1);
        }
        else if(at >= 0x1F00 && at <= 0x1F7C)
        {
            const cursor = get(o, CONST_WORD);
            if(cursor >= 0x220) throw new RangeError("NV40 vertex constant upload overflow");
            o.methods.set(VP_CONSTANTS + cursor * 16 + (at & 12), value >>> 0);
            if((at & 12) === 12) o.methods.set(CONST_WORD, cursor + 1);
        }
        return true;
    }
    programs()
    {
        return this.captured.size ? Array.from(this.captured.values()) :
            Array.from(this.graph.objects.values()).filter(o=>o.class_id===0x4097).map(o=>this.program(o));
    }
    program(o)
    {
        const result={channel:o.channel,instance:o.instance,vertex:null,fragment:null,state:Array.from(o.methods).filter(([at])=>at<0x2000),errors:[]};
        try { result.vertex=decode_vertex_program(this.vertex_program(o),get(o,0x1EA0)); }
        catch(error) { result.errors.push(String(error)); }
        try
        {
            const pointer=get(o,0x8E4), selector=pointer&3, at=selector===1?0x184:selector===2?0x188:0;
            if(!at || !o.methods.has(at)) throw new RangeError("NV40 fragment DMA unbound");
            const dma=this.device.dma.descriptor(get(o,at)*16), offset=pointer&0xFFFFFFFC, words=[];
            while(words.length<16384)
            {
                const bytes=this.device.dma.read(dma,offset+words.length*4,16), view=new DataView(bytes.buffer), header=[];
                for(let i=0;i<4;i++)header.push(view.getUint32(i*4,true));
                words.push(...header);
                if(!(header[2]&0x80000000) && header.slice(1).some(word=>(word&3)===2))
                {
                    const bytes=this.device.dma.read(dma,offset+words.length*4,16), view=new DataView(bytes.buffer);
                    for(let i=0;i<4;i++)words.push(view.getUint32(i*4,true));
                }
                if(header[0]&1) break;
            }
            result.fragment=decode_fragment_program(Uint32Array.from(words));
        }
        catch(error) { result.errors.push(String(error)); }
        return result;
    }
    shaders(o, options = {})
    {
        const program = this.program(o);
        if(program.errors.length) throw new RangeError(program.errors.join("; "));
        return {vertex: translate_vertex_program(program.vertex, options), fragment: translate_fragment_program(program.fragment, options)};
    }
    vertex_program(o, first = get(o, 0x1EA0), count = 0x220 - first)
    {
        if(first < 0 || count < 0 || first + count > 0x220) throw new RangeError("NV40 vertex program range");
        const words = new Uint32Array(count * 4);
        for(let i = 0; i < words.length; i++) words[i] = get(o, VP_CODE + (first * 4 + i) * 4);
        return words;
    }
    vertex_constants(o, first = 0, count = 0x220 - first)
    {
        if(first < 0 || count < 0 || first + count > 0x220) throw new RangeError("NV40 vertex constant range");
        const words = new Uint32Array(count * 4);
        for(let i = 0; i < words.length; i++) words[i] = get(o, VP_CONSTANTS + (first * 4 + i) * 4);
        return words;
    }
}
