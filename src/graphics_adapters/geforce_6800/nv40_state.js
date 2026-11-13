// NV40 render-target and vertex fetch state. Encodings: envytools nv30-40_3d
// and Mesa's nv30_format/nv30_vbo (MIT); all memory uses checked NV DMA.
const get=(o,at,fallback=0)=>o.methods.has(at)?o.methods.get(at):fallback;
// NV RT format -> bytes/pixel and D3DFORMAT. Values 4/5 select the two
// X8R8G8B8 padding conventions; the alpha byte is not a color channel.
const COLOR=new Map([[1,[2,24]],[2,[2,24]],[3,[2,23]],[4,[4,22]],[5,[4,22]],
    [8,[4,21]],[9,[1,50]],[11,[8,113]],[12,[16,116]],[13,[4,114]],[15,[4,33]],[16,[4,32]]]);
const RT_DMA=[0x194,0x18C,0x1B4,0x1B8],RT_OFFSET=[0x210,0x218,0x288,0x28C],RT_PITCH=[0x20C,0x21C,0x280,0x284];
export class NV40State
{
    constructor(device) {this.device=device;}
    dma(o,at)
    {
        if(!o.methods.has(at)) throw new RangeError("NV40 DMA unbound");
        return this.device.dma.descriptor(get(o,at)*16);
    }
    target(o,index=0,depth=false)
    {
        if(index<0 || index>3) throw new RangeError("NV40 invalid color target");
        const format=get(o,0x208),code=depth?format>>>5&7:format&31;
        const layout=depth?code===1?[2,80]:code===2?[4,75]:null:COLOR.get(code);
        if(!layout) throw new RangeError("NV40 unsupported render target format "+code);
        const type=format>>>8&15,u=format>>>16&255,v=format>>>24;
        if(type!==1 && type!==2 || type===2 && (u>12 || v>12)) throw new RangeError("NV40 invalid render target layout");
        const x=get(o,0x200)&65535,y=get(o,0x204)&65535;
        const width=x+(get(o,0x200)>>>16),height=y+(get(o,0x204)>>>16);
        const [bpp,d3d]=layout,pitch=get(o,depth?0x22C:RT_PITCH[index]);
        if(!width || !height || width>4096 || height>4096 || type===1 && pitch<width*bpp ||
            type===2 && (width>2**u || height>2**v)) throw new RangeError("NV40 invalid render target dimensions/pitch");
        const surface={dma:this.dma(o,depth?0x198:RT_DMA[index]),offset:get(o,depth?0x214:RT_OFFSET[index]),
            pitch,bpp,d3d,width,height,x,y,swizzle:type===2,u,v};
        return surface;
    }
    validate(surface,write)
    {
        for(let row=0;row<surface.height;row++) this.device.graph.engine2d.row(surface,0,row,surface.width,write);
    }
    read(surface)
    {
        this.validate(surface,false);
        const pitch=surface.width*surface.bpp,bytes=new Uint8Array(pitch*surface.height);
        for(let row=0;row<surface.height;row++) bytes.set(this.device.graph.engine2d.readrow(surface,0,row,surface.width),row*pitch);
        return bytes;
    }
    write(surface,bytes)
    {
        const pitch=surface.width*surface.bpp;
        if(bytes.length!==pitch*surface.height) throw new RangeError("NV40 render target readback size");
        this.validate(surface,true);
        for(let row=0;row<surface.height;row++) this.device.graph.engine2d.writerow(surface,0,row,bytes.subarray(row*pitch,(row+1)*pitch));
    }
    attribute(o,index)
    {
        if(index<0 || index>=16) throw new RangeError("NV40 invalid vertex attribute");
        return Array.from({length:4},(_,i)=>get(o,0x1C00+index*16+i*4,i===3?0x3F800000:0));
    }
    // Canonical float4 records make the D3D9 declaration independent of the
    // guest's strides and current attributes. Inline data still consumes every
    // enabled attribute, including attributes the shader does not read.
    inline_vertices(o,words,inputs)
    {
        const formats=Array.from({length:16},(_,i)=>get(o,0x1740+i*4));
        let stride=0;
        for(const format of formats)
        {
            const size=format>>>4&15;
            if(size>4 || size && (format&15)!==2) throw new RangeError("NV40 inline vertex format needs conversion");
            stride+=size;
        }
        if(!stride || words.length%stride) throw new RangeError("NV40 incomplete inline vertex");
        const count=words.length/stride,bytes=new Uint8Array(count*inputs.length*16),view=new DataView(bytes.buffer);
        const locations=new Map(inputs.map(([attribute],slot)=>[attribute,slot]));
        for(let vertex=0,at=0;vertex<count;vertex++)
        {
            for(let attribute=0;attribute<16;attribute++)
            {
                const values=this.attribute(o,attribute),size=formats[attribute]>>>4&15;
                for(let i=0;i<size;i++) values[i]=words[at++];
                if(!locations.has(attribute)) continue;
                const offset=(vertex*inputs.length+locations.get(attribute))*16;
                values.forEach((value,i)=>view.setUint32(offset+i*4,value,true));
            }
        }
        return {bytes,count,stride:inputs.length*16};
    }
    array_vertices(o,indices,inputs)
    {
        const bytes=new Uint8Array(indices.length*inputs.length*16),view=new DataView(bytes.buffer);
        for(let slot=0;slot<inputs.length;slot++)
        {
            const attribute=inputs[slot][0],format=get(o,0x1740+attribute*4),size=format>>>4&15,stride=format>>>8&255;
            if(size>4 || size && (format&15)!==2) throw new RangeError("NV40 array vertex format needs conversion");
            const offset=get(o,0x1680+attribute*4),dma=size?this.dma(o,offset&0x80000000?0x1A0:0x19C):null;
            for(let vertex=0;vertex<indices.length;vertex++)
            {
                const values=this.attribute(o,attribute),index=indices[vertex]+(get(o,0x173C)|0);
                if(!Number.isSafeInteger(index) || index<0) throw new RangeError("NV40 invalid vertex index");
                if(size)
                {
                    const data=this.device.dma.read(dma,(offset&0x0FFFFFFF)+index*stride,size*4),source=new DataView(data.buffer);
                    for(let i=0;i<size;i++) values[i]=source.getUint32(i*4,true);
                }
                const at=(vertex*inputs.length+slot)*16;
                values.forEach((value,i)=>view.setUint32(at+i*4,value,true));
            }
        }
        return {bytes,count:indices.length,stride:inputs.length*16};
    }
}
