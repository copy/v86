// NV40 uncompressed 2D texture fetch/upload. The component crossbar operates
// on the format's storage components, before the fragment program sees RGBA.
const get=(o,at,fallback=0)=>o.methods.has(at)?o.methods.get(at):fallback;
const BYTES=new Map([[1,1],[2,2],[3,2],[4,2],[5,4],[11,2]]);
export class NV40Texture
{
    constructor(state) {this.state=state;}
    describe(o,unit)
    {
        if(unit<0 || unit>=16)throw new RangeError("NV40 invalid texture unit");
        const at=0x1A00+unit*32,format=get(o,at+4),size=get(o,at+24),code=format>>>8&31,selector=format&3;
        const width=size>>>16,height=size&65535,bpp=BYTES.get(code),pitch=get(o,0x1840+unit*4)&65535;
        if(get(o,at+12)&0xF0)throw new RangeError("NV40 anisotropic texture is not connected");
        if(!(get(o,at+12)&0x80000000))throw new RangeError("NV40 sampled texture is disabled");
        if((format>>>4&15)!==2 || format&4)throw new RangeError("NV40 cube/volume texture is not connected");
        if(format&0x4000)throw new RangeError("NV40 unnormalized texture coordinates are not connected");
        if((format>>>16&15)!==1)throw new RangeError("NV40 mipmapped texture is not connected");
        if(!bpp)throw new RangeError("NV40 texture format is not connected: "+code);
        if(selector!==1 && selector!==2)throw new RangeError("NV40 texture DMA selector");
        const swizzle=!(format&0x2000),u=Math.ceil(Math.log2(width)),v=Math.ceil(Math.log2(height));
        if(!width || !height || width>4096 || height>4096 || !swizzle && pitch<width*bpp)throw new RangeError("NV40 texture dimensions/pitch");
        const wrap=get(o,at+8),filter=get(o,at+20),s=wrap&15,t=wrap>>>8&15;
        if(![1,2,3,4].includes(s) || ![1,2,3,4].includes(t))throw new RangeError("NV40 texture wrap mode is not connected");
        if(wrap&0xF00000 || filter&0xF0000000)throw new RangeError("NV40 sRGB/signed texture is not connected");
        const min=filter>>>16&15,mag=filter>>>24&15;
        if(min<1 || min>6 || mag<1 || mag>2)throw new RangeError("NV40 texture filter");
        return {dma:this.state.dma(o,selector===1?0x184:0x188),offset:get(o,at),width,height,bpp,pitch,swizzle,u,v,code,
            crossbar:get(o,at+16),wrap_s:s,wrap_t:t,min:min&1?1:2,mag,border:get(o,at+28)};
    }
    read(texture)
    {
        const source=this.state.read(texture),result=new Uint8Array(texture.width*texture.height*4),view=new DataView(source.buffer);
        const unit5=value=>Math.round(value*255/31),unit6=value=>Math.round(value*255/63);
        for(let pixel=0;pixel<texture.width*texture.height;pixel++)
        {
            const at=pixel*texture.bpp,word=texture.bpp===1?source[at]:texture.bpp===2?view.getUint16(at,true):view.getUint32(at,true);
            let components;
            if(texture.code===1)components=[word,0,0,255];
            else if(texture.code===2)components=[unit5(word&31),unit5(word>>>5&31),unit5(word>>>10&31),word&0x8000?255:0];
            else if(texture.code===3)components=[(word&15)*17,(word>>>4&15)*17,(word>>>8&15)*17,(word>>>12)*17];
            else if(texture.code===4)components=[unit5(word&31),unit6(word>>>5&63),unit5(word>>>11),255];
            else if(texture.code===5)components=[word&255,word>>>8&255,word>>>16&255,word>>>24];
            else components=[word&255,0,0,word>>>8];
            for(let channel=0;channel<4;channel++)
            {
                const shift=(3-channel)*2,select=texture.crossbar>>>(shift+8)&3,component=3-(texture.crossbar>>>shift&3);
                if(select===3)throw new RangeError("NV40 invalid texture component selection");
                result[pixel*4+channel]=select===0?0:select===1?255:components[component];
            }
        }
        return result;
    }
}
