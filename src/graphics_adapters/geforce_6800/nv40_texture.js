// NV40 2D/cube/volume texture fetch/upload. The component crossbar operates
// on the format's storage components, before the fragment program sees RGBA.
const get=(o,at,fallback=0)=>o.methods.has(at)?o.methods.get(at):fallback;
const BYTES=new Map([[1,1],[2,2],[3,2],[4,2],[5,4],[11,2],[16,4],[18,2],[26,8],[27,16],[28,4]]);
const BLOCK_BYTES=new Map([[6,8],[7,16],[8,16]]);
export class NV40Texture
{
    constructor(state) {this.state=state;}
    vertex(o,unit)
    {
        if(!Number.isInteger(unit) || unit<0 || unit>=4)throw new RangeError("NV40 invalid vertex texture unit");
        const at=0x900+unit*32,format=get(o,at+4),code=format>>>8&31,dimension=format>>>4&3;
        const enable=get(o,at+12),control=get(o,at+16),filter=get(o,at+20),rect=get(o,at+24),wrap=get(o,at+8);
        // Curie XF textures support linear R32F/RGBA32F, 1D/2D, nearest
        // sampling only. These constraints are exercised by envytools hwtest.
        if(format&~0xFFF33 || (format&0xE000)!==0xA000 || ![27,28].includes(code) || ![1,2].includes(dimension))
            throw new RangeError("NV40 invalid vertex texture format");
        const selector=format&3,levels=format>>>16&15,width=rect>>>16,height=dimension===1?1:rect&65535,bpp=code===27?16:4;
        if(selector!==1 && selector!==2 || !levels || levels>13)throw new RangeError("NV40 invalid vertex texture DMA/mips");
        if(!(enable&0x80000000))throw new RangeError("NV40 sampled vertex texture is disabled");
        if(enable&127 || control&~0x3FFFF || filter&~0x1FFF || get(o,at)&127 || wrap&~0xF0F)
            throw new RangeError("NV40 invalid vertex texture state");
        const pitch=control&0x3FFFF,s=wrap&15,t=wrap>>>8&15;
        if(!width || !height || width>4096 || height>4096 || pitch<width*bpp || levels>1+Math.floor(Math.log2(Math.max(width,height))))
            throw new RangeError("NV40 invalid vertex texture dimensions/pitch");
        if(![1,2,3,4].includes(s) || ![1,2,3,4].includes(t))throw new RangeError("NV40 vertex texture wrap mode is not connected");
        // Clamp the explicit LOD in the vertex shader, preserving fractional
        // limits and bias without adding either to the shader cache key.
        return {dma:this.state.dma(o,selector===1?0x184:0x188),offset:get(o,at),width,height,depth:1,bpp,pitch,swizzle:false,
            u:Math.ceil(Math.log2(width)),v:Math.ceil(Math.log2(height)),w:0,code,block:0,cube:false,volume:false,normalized:true,vertex:true,
            wrap_s:s,wrap_t:t,wrap_r:3,min:1,mag:1,mip:1,levels,min_lod:0,level_count:levels,bias:0,border:get(o,at+28),
            d3d:code===27?116:114,upload_bpp:bpp};
    }
    describe(o,unit)
    {
        if(unit<0 || unit>=16)throw new RangeError("NV40 invalid texture unit");
        const at=0x1A00+unit*32,format=get(o,at+4),size=get(o,at+24),code=format>>>8&31,selector=format&3;
        const width=size>>>16,height=size&65535,block=BLOCK_BYTES.get(code),bpp=BYTES.get(code)||block,pitch=get(o,0x1840+unit*4)&65535;
        if(get(o,at+12)&0x70)throw new RangeError("NV40 anisotropic texture is not connected");
        if(!(get(o,at+12)&0x80000000))throw new RangeError("NV40 sampled texture is disabled");
        const cube=!!(format&4),dimension=format>>>4&15,volume=dimension===3;
        const depthCompare=code===16 || code===18;
        if(depthCompare && (cube || volume))throw new RangeError("NV40 depth comparison needs a 2D texture");
        if(dimension!==2 && !volume || cube && volume)throw new RangeError("NV40 invalid texture dimension");
        const depth=volume?get(o,0x1840+unit*4)>>>20:1;
        if(volume && (!depth || Math.max(width,height,depth)>512))throw new RangeError("NV40 volume texture dimensions");
        if(volume && block)throw new RangeError("NV40 compressed volume texture is not connected");
        if(cube && width!==height)throw new RangeError("NV40 cube faces must be square");
        const normalized=!(format&0x4000);
        if(cube && !normalized)throw new RangeError("NV40 unnormalized cube coordinates");
        const levels=format>>>16&15;
        if(!levels || levels>1+Math.floor(Math.log2(Math.max(width,height,depth))))throw new RangeError("NV40 invalid texture mip count");
        if(depthCompare && levels!==1)throw new RangeError("NV40 depth comparison mip chains are not connected");
        if(!bpp)throw new RangeError("NV40 texture format is not connected: "+code);
        if(selector!==1 && selector!==2)throw new RangeError("NV40 texture DMA selector");
        const swizzle=!(format&0x2000),u=Math.ceil(Math.log2(width)),v=Math.ceil(Math.log2(height)),w=Math.ceil(Math.log2(depth));
        if(!width || !height || width>4096 || height>4096 || !swizzle && pitch<(block?Math.ceil(width/4)*block:width*bpp))throw new RangeError("NV40 texture dimensions/pitch");
        const wrap=get(o,at+8),filter=get(o,at+20),s=wrap&15,t=wrap>>>8&15,r=wrap>>>16&15;
        if(![1,2,3,4].includes(s) || ![1,2,3,4].includes(t) || volume && ![1,2,3,4].includes(r))throw new RangeError("NV40 texture wrap mode is not connected");
        const gamma=wrap>>>20&15;
        if(gamma && (gamma!==7 || depthCompare || [26,27,28].includes(code)))
            throw new RangeError("NV40 per-component/float texture gamma is not connected");
        if(filter&0xF0000000)throw new RangeError("NV40 signed texture is not connected");
        const min=filter>>>16&15,mag=filter>>>24&15;
        if(min<1 || min>6 || mag<1 || mag>2)throw new RangeError("NV40 texture filter");
        const fullFloat=code===27 || code===28;
        if(fullFloat && (mag!==1 || min!==1 && min!==3))throw new RangeError("NV40 FP32 texture filtering is not connected");
        const enable=get(o,at+12),minLod=(enable>>>19&4095)/256,maxLod=(enable>>>7&4095)/256;
        if(minLod%1 || maxLod%1)throw new RangeError("NV40 fractional texture LOD clamp is not connected");
        return {dma:this.state.dma(o,selector===1?0x184:0x188),offset:get(o,at),width,height,depth,bpp,pitch,swizzle,u,v,w,code,block,cube,volume,normalized,
            crossbar:get(o,at+16),srgb:gamma===7,wrap_s:s,wrap_t:t,wrap_r:r,min:min&1?1:2,mag,mip:min<=2?0:min<=4?1:2,
            levels,min_lod:Math.min(levels-1,minLod),level_count:Math.min(levels,maxLod+1),
            d3d:depthCompare?code===16?75:80:fullFloat?116:code===26?113:32,
            upload_bpp:depthCompare?bpp:fullFloat?16:code===26?8:4,depth_compare:depthCompare,
            bias:new Uint32Array(Float32Array.of((filter<<19>>19)/256).buffer)[0],border:get(o,at+28)};
    }
    images(texture)
    {
        const images=[],layouts=[];let stride=0;
        // Face offsets include the complete guest mip chain, even when the
        // sampler's LOD clamp makes only its first levels visible.
        for(let level=0;level<texture.levels;level++)
        {
            const width=Math.max(1,texture.width>>>level),height=Math.max(1,texture.height>>>level);
            const u=Math.max(0,texture.u-level),v=Math.max(0,texture.v-level),w=Math.max(0,texture.w-level),depth=Math.max(1,texture.depth>>>level);
            layouts.push({width,height,depth,u,v,w,offset:stride});
            stride+=texture.block?Math.ceil(height/4)*(texture.swizzle?Math.ceil(width/4)*texture.block:texture.pitch):
                texture.swizzle?2**(u+v+w)*texture.bpp:height*depth*texture.pitch;
        }
        // NV40 packed/Morton cube faces are 128-byte aligned. Uniform-pitch
        // linear faces follow their complete mip chains without that padding.
        if(texture.cube && texture.swizzle)stride=Math.ceil(stride/128)*128;
        for(let face=0;face<(texture.cube?6:1);face++)for(let level=0;level<texture.level_count;level++)
        {
            const layout=layouts[level];
            images.push(this.read({...texture,...layout,offset:texture.offset+face*stride+layout.offset}));
        }
        return images;
    }
    storage(texture)
    {
        if(!texture.volume)return this.state.read(texture);
        const {width,height,depth,bpp,pitch,swizzle,u,v,w}=texture,device=this.state.device;
        const length=swizzle?2**(u+v+w)*bpp:(depth*height-1)*pitch+width*bpp;
        if(length>device.vram_size || width*height*depth*texture.upload_bpp>device.vram_size)
            throw new RangeError("NV40 volume texture exceeds upload budget");
        const source=device.dma.read(texture.dma,texture.offset,length),result=new Uint8Array(width*height*depth*bpp);
        for(let z=0;z<depth;z++)for(let y=0;y<height;y++)for(let x=0;x<width;x++)
        {
            let at=(z*height+y)*pitch+x*bpp;
            if(swizzle)
            {
                let index=0,bit=0;
                for(let i=0;i<Math.max(u,v,w);i++)
                {
                    if(i<u)index|=(x>>>i&1)<<bit++;
                    if(i<v)index|=(y>>>i&1)<<bit++;
                    if(i<w)index|=(z>>>i&1)<<bit++;
                }
                at=index*bpp;
            }
            result.set(source.subarray(at,at+bpp),((z*height+y)*width+x)*bpp);
        }
        return result;
    }
    read(texture)
    {
        if(texture.vertex || texture.depth_compare)return this.storage(texture);
        if(texture.code===27 || texture.code===28)
        {
            const pixels=texture.width*texture.height*(texture.depth||1);
            if(pixels*16>this.state.device.vram_size)throw new RangeError("NV40 FP32 texture exceeds upload budget");
            const bytes=this.storage(texture),source=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),
                result=new Uint8Array(pixels*16),output=new DataView(result.buffer);
            for(let pixel=0;pixel<pixels;pixel++)for(let channel=0;channel<4;channel++)
            {
                const shift=(3-channel)*2,select=texture.crossbar>>>(shift+8)&3,component=3-(texture.crossbar>>>shift&3);
                if(select===3)throw new RangeError("NV40 invalid texture component selection");
                // The scalar format expands to (R,0,0,1) before the crossbar.
                // Copy integer bits so payloads and signed zero survive upload.
                const bits=select===0?0:select===1?0x3F800000:
                    texture.code===27 || component===0?source.getUint32(pixel*texture.bpp+component*4,true):component===3?0x3F800000:0;
                output.setUint32(pixel*16+channel*4,bits,true);
            }
            return result;
        }
        if(texture.code===26)
        {
            const bytes=this.storage(texture),result=new Uint8Array(bytes.length),
                source=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),output=new DataView(result.buffer);
            for(let pixel=0;pixel<texture.width*texture.height*(texture.depth||1);pixel++)for(let channel=0;channel<4;channel++)
            {
                const shift=(3-channel)*2,select=texture.crossbar>>>(shift+8)&3,component=3-(texture.crossbar>>>shift&3);
                if(select===3)throw new RangeError("NV40 invalid texture component selection");
                output.setUint16(pixel*8+channel*2,select===0?0:select===1?0x3C00:source.getUint16(pixel*8+component*2,true),true);
            }
            return result;
        }
        const source=texture.block?this.blocks(texture):this.storage(texture),result=new Uint8Array(texture.width*texture.height*(texture.depth||1)*4),view=new DataView(source.buffer);
        const unit5=value=>Math.round(value*255/31),unit6=value=>Math.round(value*255/63);
        for(let pixel=0;pixel<texture.width*texture.height*(texture.depth||1);pixel++)
        {
            const at=pixel*(texture.block?4:texture.bpp),word=texture.bpp===1?source[at]:texture.bpp===2?view.getUint16(at,true):view.getUint32(at,true);
            let components;
            if(texture.block)components=source.subarray(at,at+4);
            else if(texture.code===1)components=[word,0,0,255];
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
    blocks(t)
    {
        const width=Math.ceil(t.width/4),height=Math.ceil(t.height/4),pitch=t.swizzle?width*t.block:t.pitch;
        const result=new Uint8Array(t.width*t.height*4);
        const color=value=>{const b=value&31,g=value>>>5&63,r=value>>>11;return [b<<3|b>>>2,g<<2|g>>>4,r<<3|r>>>2,255];};
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)
        {
            const bytes=this.state.device.dma.read(t.dma,t.offset+y*pitch+x*t.block,t.block),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
            const c=t.code===6?0:8,a=v.getUint16(c,true),b=v.getUint16(c+2,true),colors=[color(a),color(b)];
            if(a>b || t.code!==6)
                colors.push(colors[0].map((value,i)=>i===3?255:Math.round((2*value+colors[1][i])/3)),
                    colors[0].map((value,i)=>i===3?255:Math.round((value+2*colors[1][i])/3)));
            else colors.push(colors[0].map((value,i)=>i===3?255:Math.floor((value+colors[1][i])/2)),[0,0,0,0]);
            const alpha=[bytes[0],bytes[1]],denominator=alpha[0]>alpha[1]?7:5;
            for(let i=1;i<denominator;i++)alpha.push(Math.round(((denominator-i)*alpha[0]+i*alpha[1])/denominator));
            if(denominator===5)alpha.push(0,255);
            const selectors=v.getUint32(c+4,true);
            for(let dy=0;dy<4 && y*4+dy<t.height;dy++)for(let dx=0;dx<4 && x*4+dx<t.width;dx++)
            {
                const pixel=dy*4+dx,at=((y*4+dy)*t.width+x*4+dx)*4;
                result.set(colors[selectors>>>(pixel*2)&3],at);
                if(t.code===7)result[at+3]=(bytes[pixel>>>1]>>>((pixel&1)*4)&15)*17;
                else if(t.code===8)
                {
                    const bit=pixel*3,index=2+(bit>>>3),bits=bytes[index]|(index<7?bytes[index+1]<<8:0);
                    result[at+3]=alpha[bits>>>(bit&7)&7];
                }
            }
        }
        return result;
    }
}
