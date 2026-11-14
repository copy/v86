// NV40 render-target and vertex fetch state. Encodings: envytools nv30-40_3d
// and Mesa's nv30_format/nv30_vbo (MIT); all memory uses checked NV DMA.
const get=(o,at,fallback=0)=>o.methods.has(at)?o.methods.get(at):fallback;
// NV RT format -> bytes/pixel and D3DFORMAT. Values 4/5 select the two
// X8R8G8B8 padding conventions; the alpha byte is not a color channel.
const COLOR=new Map([[1,[2,24]],[2,[2,24]],[3,[2,23]],[4,[4,22]],[5,[4,22]],
    [8,[4,21]],[9,[1,50]],[11,[8,113]],[12,[16,116]],[13,[4,114]],[15,[4,33]],[16,[4,32]]]);
const RT_DMA=[0x194,0x18C,0x1B4,0x1B8],RT_OFFSET=[0x210,0x218,0x288,0x28C],RT_PITCH=[0x20C,0x21C,0x280,0x284];
const f32bits=value=>new Uint32Array(Float32Array.of(value).buffer)[0];
// Curie's alternate DirectX declaration encoding (VTXFMT bit 16). The
// replicated low nibble is a type code, not TYPE/SIZE. Native 93.71 uses
// 0x114BB for FLOAT4 and 0x114CC for D3DCOLOR with a 20-byte stride.
const DX_VERTEX=new Map([[0x44,[4,4]],[0x88,[2,1]],[0x99,[2,2]],[0xAA,[2,3]],
    [0xBB,[2,4]],[0xCC,[0,4]],[0xEE,[5,2]]]);
const half=value=>{
    const sign=value&0x8000?-1:1,exponent=value>>>10&31,mantissa=value&1023;
    return sign*(exponent===31?mantissa?NaN:Infinity:exponent?2**(exponent-15)*(1+mantissa/1024):2**-14*mantissa/1024);
};
export class NV40State
{
    constructor(device) {this.device=device;this.morton_axes=new Map();}
    packed(surface)
    {
        return surface.swizzle?surface.width===2**surface.u && surface.height===2**surface.v:surface.pitch===surface.width*surface.bpp;
    }
    axes(surface)
    {
        const key=surface.u+":"+surface.v;
        if(!this.morton_axes.has(key))
        {
            const axes=[new Uint32Array(surface.width),new Uint32Array(surface.height)],sizes=[surface.u,surface.v],bits=Math.max(...sizes);
            for(let axis=0;axis<2;axis++)for(let value=0;value<axes[axis].length;value++)
            {
                let index=0,bit=0;
                for(let i=0;i<bits;i++)for(let a=0;a<2;a++)if(i<sizes[a])
                {if(a===axis)index|=(value>>>i&1)<<bit;bit++;}
                axes[axis][value]=index;
            }
            this.morton_axes.set(key,axes);
        }
        return this.morton_axes.get(key);
    }
    reorder(surface,source,to_morton)
    {
        const result=new Uint8Array(source.length),[xs,ys]=this.axes(surface),bpp=surface.bpp;
        for(let y=0;y<surface.height;y++)for(let x=0;x<surface.width;x++)
        {
            const linear=(y*surface.width+x)*bpp,morton=(xs[x]|ys[y])*bpp;
            const from=to_morton?linear:morton,to=to_morton?morton:linear;
            for(let byte=0;byte<bpp;byte++)result[to+byte]=source[from+byte];
        }
        return result;
    }
    dma(o,at)
    {
        if(!o.methods.has(at)) throw new RangeError("NV40 DMA unbound");
        return this.device.dma.descriptor(get(o,at)*16);
    }
    raster_area(o)
    {
        const format=get(o,0x208);
        const type=format>>>8&15,u=format>>>16&255,v=format>>>24;
        if(type!==1 && type!==2 || type===2 && (u>12 || v>12)) throw new RangeError("NV40 invalid render target layout");
        const x=get(o,0x200)&65535,y=get(o,0x204)&65535;
        const width=x+(get(o,0x200)>>>16),height=y+(get(o,0x204)>>>16);
        if(!width || !height || width>4096 || height>4096 ||
            type===2 && (width>2**u || height>2**v)) throw new RangeError("NV40 invalid render target dimensions/pitch");
        return {width,height,x,y,swizzle:type===2,u,v};
    }
    target(o,index=0,depth=false)
    {
        if(index<0 || index>3) throw new RangeError("NV40 invalid color target");
        const format=get(o,0x208),code=depth?format>>>5&7:format&31;
        const layout=depth?code===1?[2,80]:code===2?[4,75]:null:COLOR.get(code);
        if(!layout) throw new RangeError("NV40 unsupported render target format "+code);
        const area=this.raster_area(o),[bpp,d3d]=layout,pitch=get(o,depth?0x22C:RT_PITCH[index]);
        if(!area.swizzle && pitch<area.width*bpp)throw new RangeError("NV40 invalid render target dimensions/pitch");
        const surface={dma:this.dma(o,depth?0x198:RT_DMA[index]),offset:get(o,depth?0x214:RT_OFFSET[index]),
            pitch,bpp,d3d,...area};
        return surface;
    }
    validate(surface,write)
    {
        if(this.packed(surface)){this.device.dma.ranges(surface.dma,surface.offset,surface.width*surface.height*surface.bpp,write);return;}
        for(let row=0;row<surface.height;row++) this.device.graph.engine2d.row(surface,0,row,surface.width,write);
    }
    read(surface)
    {
        if(this.packed(surface))
        {
            const bytes=this.device.dma.read(surface.dma,surface.offset,surface.width*surface.height*surface.bpp);
            return surface.swizzle?this.reorder(surface,bytes,false):bytes;
        }
        this.validate(surface,false);
        const pitch=surface.width*surface.bpp,bytes=new Uint8Array(pitch*surface.height);
        for(let row=0;row<surface.height;row++) bytes.set(this.device.graph.engine2d.readrow(surface,0,row,surface.width),row*pitch);
        return bytes;
    }
    write(surface,bytes)
    {
        const pitch=surface.width*surface.bpp;
        if(bytes.length!==pitch*surface.height) throw new RangeError("NV40 render target readback size");
        if(this.packed(surface))
        {
            this.device.dma.write(surface.dma,surface.offset,surface.swizzle?this.reorder(surface,bytes,true):bytes);return;
        }
        this.validate(surface,true);
        for(let row=0;row<surface.height;row++) this.device.graph.engine2d.writerow(surface,0,row,bytes.subarray(row*pitch,(row+1)*pitch));
    }
    clear(o,flags)
    {
        if(flags&~0xF3) throw new RangeError("NV40 invalid clear mask");
        const jobs=[],colors=get(o,0x220,1)&15;
        if(flags&0xF0) for(let i=0;i<4;i++) if(colors&1<<i)
        {
            const target=this.target(o,i),channels=target.d3d===23?[0xF800,0x7E0,31,0]:target.d3d===24?[0x7C00,0x3E0,31,0x8000]:
                [21,22].includes(target.d3d)?[0xFF0000,0xFF00,255,0xFF000000]:
                [32,33].includes(target.d3d)?[255,0xFF00,0xFF0000,0xFF000000]:null;
            if(!channels) throw new RangeError("NV40 unsupported clear color format");
            let mask=0;channels.forEach((bits,channel)=>{if(flags&0x10<<channel)mask|=bits;});
            jobs.push({target,mask:mask>>>0,value:get(o,0x1D90)});
        }
        if(flags&3)
        {
            const target=this.target(o,0,true),stencil=get(o,0x32C,255)&255;
            const mask=target.bpp===2?flags&1?65535:0:(flags&1?0xFFFFFF00:0)|(flags&2?stencil:0);
            jobs.push({target,mask:mask>>>0,value:get(o,0x1D8C)});
        }
        // Validate every destination first: a late depth/MRT fault must not
        // leave an earlier color target partially cleared.
        for(const {target}of jobs)this.validate(target,true);
        const x=get(o,0x8C0,0x10000000),y=get(o,0x8C4,0x10000000);
        for(const {target,mask,value}of jobs)
        {
            const left=Math.max(target.x,x&65535),top=Math.max(target.y,y&65535);
            const right=Math.min(target.width,(x&65535)+(x>>>16)),bottom=Math.min(target.height,(y&65535)+(y>>>16));
            for(let row=top;row<bottom && right>left;row++)
            {
                const bytes=this.device.graph.engine2d.readrow(target,left,row,right-left),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
                for(let at=0;at<bytes.length;at+=target.bpp)
                {
                    const old=target.bpp===2?view.getUint16(at,true):view.getUint32(at,true),updated=(old&~mask)|(value&mask);
                    if(target.bpp===2)view.setUint16(at,updated,true);else view.setUint32(at,updated,true);
                }
                this.device.graph.engine2d.writerow(target,left,row,bytes);
            }
        }
    }
    results(o)
    {
        // Curie output routing, not the compiler's conventional register names.
        // envytools hwtest MthdCurieXfOutMapMisc/TxcA/TxcB: packed nibbles,
        // and 6-bit register/component selectors for fog and point size.
        const misc=get(o,0x1FC4,0x06144321),tex=get(o,0x1FC8,0xEDCBA987);
        const mask=o.methods.has(0x1FF4)?get(o,0x1FF4):null;
        const enabled=bit=>mask===null?null:!!(mask&1<<bit),routes=[[0,0,-1,true]];
        for(let i=0;i<4;i++) routes.push([i+1,misc>>>(i*4)&15,-1,enabled(i)]);
        for(let i=0;i<2;i++)
        {
            const selector=misc>>>(16+i*6)&63;
            routes.push([5+i,selector>>>2,selector&3,enabled(4+i)]);
        }
        for(let i=0;i<8;i++) routes.push([7+i,tex>>>(i*4)&15,-1,enabled(14+i)]);
        const extra=get(o,0x1FCC);
        for(let i=0;i<2;i++)routes.push([15+i,extra>>>(i*4)&15,-1,mask!==null&&enabled(12+i)]);
        return routes;
    }
    viewport(o,target)
    {
        if(get(o,0x1E94)&0x100)return {x:0,y:0,width:target.width,height:target.height,bypass:true};
        const number=at=>new Float32Array(Uint32Array.of(get(o,at)).buffer)[0];
        const scale=[0,1,2].map(i=>number(0xA30+i*4)),translate=[0,1,2].map(i=>number(0xA20+i*4));
        const width=2*Math.abs(scale[0]),height=2*Math.abs(scale[1]);
        const x=translate[0]-width/2,y=translate[1]-height/2;
        if(!scale.concat(translate,[x,y,width,height]).every(Number.isFinite) || width<=0 || height<=0)
            throw new RangeError("NV40 invalid viewport bounds");
        // NV permits fractional offsets (93.71 uses +0.5 in Direct3D) and
        // viewports that extend past the attachment. D9WG's viewport is integer:
        // lower the original affine transform into the vertex program against
        // the full attachment, then clip to the viewport's pixel-center bounds.
        const clip={left:Math.max(0,Math.ceil(x-.5)),top:Math.max(0,Math.ceil(y-.5)),
            right:Math.min(target.width,Math.ceil(x+width-.5)),bottom:Math.min(target.height,Math.ceil(y+height-.5))};
        return {x:0,y:0,width:target.width,height:target.height,bypass:false,scale,translate,clip};
    }
    attribute(o,index)
    {
        if(index<0 || index>=16) throw new RangeError("NV40 invalid vertex attribute");
        return Array.from({length:4},(_,i)=>get(o,0x1C00+index*16+i*4,i===3?0x3F800000:0));
    }
    vertex_layout(format)
    {
        let type=format&15,size=format>>>4&15;
        if(format&0x10000)
        {
            const dx=DX_VERTEX.get(format&255);
            if(!dx) throw new RangeError("NV40 unsupported DirectX vertex format");
            [type,size]=dx;
        }
        if(size>4 || size && ![0,1,2,3,4,5,7].includes(type) || size && type===0 && size<3)
            throw new RangeError("NV40 unsupported vertex format");
        return {type,size,bytes:type===0 && size?4:size*(type===2?4:[1,3,5].includes(type)?2:1)};
    }
    vertex_value(layout,bytes)
    {
        const {type,size}=layout,view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),values=[0,0,0,0x3F800000];
        for(let i=0;i<size;i++)
        {
            if(type===2) {values[i]=view.getUint32(i*4,true);continue;}
            let value;
            if(type===0) value=view.getUint8(i===0?2:i===2?0:i)/255;
            else if(type===1) value=Math.max(-1,view.getInt16(i*2,true)/32767);
            else if(type===3) value=half(view.getUint16(i*2,true));
            else if(type===5) value=view.getInt16(i*2,true);
            else value=view.getUint8(i)/(type===4?255:1);
            values[i]=f32bits(value);
        }
        return values;
    }
    // Canonical float4 records make the D3D9 declaration independent of the
    // guest's strides and current attributes. Inline data still consumes every
    // enabled attribute, including attributes the shader does not read.
    inline_vertices(o,words,inputs)
    {
        const formats=Array.from({length:16},(_,i)=>this.vertex_layout(get(o,0x1740+i*4)));
        let stride=0;
        for(const format of formats)
        {
            stride+=Math.ceil(format.bytes/4);
        }
        if(!stride || words.length%stride) throw new RangeError("NV40 incomplete inline vertex");
        const count=words.length/stride,bytes=new Uint8Array(count*inputs.length*16),view=new DataView(bytes.buffer);
        const locations=new Map(inputs.map(([attribute],slot)=>[attribute,slot]));
        for(let vertex=0,at=0;vertex<count;vertex++)
        {
            for(let attribute=0;attribute<16;attribute++)
            {
                const layout=formats[attribute],size=Math.ceil(layout.bytes/4);
                let values=this.attribute(o,attribute);
                if(size)
                {
                    const packed=new Uint32Array(size);for(let i=0;i<size;i++)packed[i]=words[at++];
                    values=this.vertex_value(layout,new Uint8Array(packed.buffer));
                }
                if(!locations.has(attribute)) continue;
                const offset=(vertex*inputs.length+locations.get(attribute))*16;
                values.forEach((value,i)=>view.setUint32(offset+i*4,value,true));
            }
        }
        return {bytes,count,stride:inputs.length*16};
    }
    indices(o,first,count)
    {
        const format=get(o,0x1820),type=format>>>4&15;
        if(type>1 || format&~0x11) throw new RangeError("NV40 invalid index buffer format");
        if(!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first<0 || count<0 || count>1<<20)
            throw new RangeError("NV40 invalid index buffer range");
        const size=type===1?2:4,dma=this.dma(o,format&1?0x1A0:0x19C);
        const bytes=this.device.dma.read(dma,get(o,0x181C)+first*size,count*size),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
        return Array.from({length:count},(_,i)=>size===2?view.getUint16(i*2,true):view.getUint32(i*4,true));
    }
    array_vertices(o,indices,inputs)
    {
        const bytes=new Uint8Array(indices.length*inputs.length*16),view=new DataView(bytes.buffer);
        for(let slot=0;slot<inputs.length;slot++)
        {
            const attribute=inputs[slot][0],format=get(o,0x1740+attribute*4),layout=this.vertex_layout(format),stride=format>>>8&255;
            const offset=get(o,0x1680+attribute*4),dma=layout.size?this.dma(o,offset&0x80000000?0x1A0:0x19C):null;
            for(let vertex=0;vertex<indices.length;vertex++)
            {
                let values=this.attribute(o,attribute);const index=indices[vertex]+(get(o,0x173C)|0);
                if(!Number.isSafeInteger(index) || index<0) throw new RangeError("NV40 invalid vertex index");
                if(layout.size)
                {
                    const data=this.device.dma.read(dma,(offset&0x0FFFFFFF)+index*stride,layout.bytes);
                    values=this.vertex_value(layout,data);
                }
                const at=(vertex*inputs.length+slot)*16;
                values.forEach((value,i)=>view.setUint32(at+i*4,value,true));
            }
        }
        return {bytes,count:indices.length,stride:inputs.length*16};
    }
}
