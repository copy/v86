// Hardware method draws -> the shared D9WG/WebGPU executor. VRAM remains the
// snapshot authority: every submitted target is downloaded before FIFO resumes.
import {D9WGWriter} from "../vmware_svga/svga3d_d9wg.js";
import {OP} from "../vmware_svga/d9wg_constants.js";
import {NV40Texture} from "./nv40_texture.js";
import {QUERY_REGION_BYTES,READBACK_MAX_BYTES,RESPONSE_OK} from "../renderer_protocol.js";
const QUERY_COUNT=0x50008;
const get=(o,at,fallback=0)=>o.methods.has(at)?o.methods.get(at):fallback;
const float_value=word=>new Float32Array(Uint32Array.of(word).buffer)[0];
const float_word=value=>new Uint32Array(Float32Array.of(value).buffer)[0];
const data=typed=>new Uint8Array(typed.buffer,typed.byteOffset,typed.byteLength);
const equal_bytes=(a,b)=>{
    if(!a || a.length!==b.length)return false;
    const count=a.length>>>2,aw=new Uint32Array(a.buffer,a.byteOffset,count),bw=new Uint32Array(b.buffer,b.byteOffset,count);
    for(let i=0;i<count;i++)if(aw[i]!==bw[i])return false;
    for(let i=count*4;i<a.length;i++)if(a[i]!==b[i])return false;
    return true;
};
const BLEND=new Map([[0,1],[1,2],[0x300,3],[0x301,4],[0x302,5],[0x303,6],[0x304,7],[0x305,8],
    [0x306,9],[0x307,10],[0x308,11],[0x8001,14],[0x8002,15],[0x8003,14],[0x8004,15],
    ...Array.from({length:11},(_,i)=>[0x1001+i,i+1]),[0x100C,5],[0x100D,6],[0x100E,14],[0x100F,15]]);
const EQUATION=new Map([[0x8006,1],[0x800A,2],[0x800B,3],[0x8007,4],[0x8008,5],...[1,2,3,4,5].map(i=>[i,i])]);
const STENCIL=new Map([[0x1E00,1],[0,2],[0x1E01,3],[0x1E02,4],[0x1E03,5],[0x150A,6],[0x8507,7],[0x8508,8],
    ...Array.from({length:8},(_,i)=>[i+1,i+1])]);
// Curie accepts the native DirectX comparison aliases as well as GL enums
// (envytools hwtest MthdKelvin{DepthFunc,AlphaFuncFunc,StencilFunc}).
const comparison=value=>{
    if(value>=1 && value<=8)return value;
    if(value>=0x200 && value<=0x207)return value-0x1FF;
    throw new RangeError("NV40 invalid depth/stencil/alpha comparison");
};
export function nv40_cull_state(o)
{
    if(!get(o,0x183C))return {state:1,all:false};
    const face=get(o,0x1830,0x405),front=get(o,0x1834,0x901);
    if(![0x404,0x405,0x408].includes(face) || ![0x900,0x901].includes(front))
        throw new RangeError("NV40 invalid face culling state");
    // Both APIs define CW in window coordinates. Their viewport Y flips are
    // already accounted for by the position lowering.
    return {state:face===0x408?1:(face===0x404)===(front===0x900)?2:3,all:face===0x408};
}
export function nv40_depth_state(o,stencilAvailable=true,mode=5)
{
    const depth=!!get(o,0xA74),stencil=!!get(o,0x328)&&stencilAvailable;
    if(get(o,0x380))throw new RangeError("NV40 depth bounds is not connected");
    const offset=mode>=5&&!!get(o,0xA68),factor=offset?float_value(get(o,0xA78)):0,units=offset?float_value(get(o,0xA7C)):0;
    if(!Number.isFinite(factor) || !Number.isFinite(units))throw new RangeError("NV40 non-finite polygon offset");
    const twoSided=stencil&&!!get(o,0x348);
    // Curie stores twice the conventional polygon-offset units (Mesa nv30
    // rasterizer state). D9WG adds a normalised constant in the pixel shader,
    // so use the guest depth format's precision even when the host widens it.
    const result=[[7,+depth],[14,depth?+!!get(o,0xA70):0],[23,depth?comparison(get(o,0xA6C,0x201)):8],
        [175,float_word(factor)],[195,float_word(units/(stencilAvailable?0x2000000:0x20000))],[52,+stencil],[185,+twoSided]];
    if(stencil)
    {
        if(twoSided && [[0x32C,255],[0x334,0],[0x338,255]].some(([at,fallback])=>
            (get(o,at,fallback)&255)!==(get(o,at+32,fallback)&255)))
            throw new RangeError("NV40 independent stencil references/masks are not connected");
        const front=get(o,0x1834,0x901);
        if(twoSided && front!==0x900 && front!==0x901)throw new RangeError("NV40 invalid stencil front winding");
        // D3D's ordinary bank is CW and its second bank is CCW, regardless
        // of culling. NV's banks follow the programmable front winding.
        const banks=twoSided?(front===0x900?[0,32]:[32,0]):[0];
        for(const [bank,offset]of banks.entries())
        {
            for(const [state,at]of [[bank?186:53,0x33C],[bank?187:54,0x340],[bank?188:55,0x344]])
            {
                const operation=get(o,at+offset,0x1E00);
                if(!STENCIL.has(operation))throw new RangeError("NV40 invalid stencil operation");
                result.push([state,STENCIL.get(operation)]);
            }
            result.push([bank?189:56,comparison(get(o,0x330+offset,0x207))]);
        }
        result.push([57,get(o,0x334)&255],[58,get(o,0x338,255)&255],[59,get(o,0x32C,255)&255]);
    }
    return {enabled:depth||stencil,stencil,states:result};
}
export function nv40_blend_state(o)
{
    const alpha=!!get(o,0x304),blend=!!get(o,0x310),compare=get(o,0x308,0x207);
    const result=[[15,+alpha],[25,alpha?comparison(compare):8],[24,get(o,0x30C)&255],[27,+blend]];
    if(!blend)return result;
    const source=get(o,0x314,0x00010001),destination=get(o,0x318),equation=get(o,0x320,0x80068006);
    const convert=(table,value)=>{if(!table.has(value))throw new RangeError("NV40 unsupported blend enum");return table.get(value);};
    const rgb=[source&65535,destination&65535],constantAlpha=rgb.some(value=>value===0x8003 || value===0x8004);
    let constant=get(o,0x31C);
    if(constantAlpha)
    {
        const replicated=((constant>>>24)*0x01010101)>>>0;
        // WebGPU exposes one constant vector. Replicating A into RGB also
        // preserves the separate alpha factors. A simultaneous RGB constant
        // color needs a second vector unless its components already equal A.
        if(constant!==replicated && rgb.some(value=>value===0x8001 || value===0x8002 || value===0x100E || value===0x100F))
            throw new RangeError("NV40 mixed constant-color/constant-alpha RGB blend is not connected");
        constant=replicated;
    }
    result.push([19,convert(BLEND,source&65535)],[20,convert(BLEND,destination&65535)],
        [171,convert(EQUATION,equation&65535)],[193,constant],
        [206,1],[207,convert(BLEND,source>>>16)],[208,convert(BLEND,destination>>>16)],
        [209,convert(EQUATION,equation>>>16)]);
    return result;
}

export function expand_primitives(vertices,mode)
{
    const n=vertices.count,indices=[];let type=4,divisor=3;
    if(mode===1) {type=1;divisor=1;for(let i=0;i<n;i++)indices.push(i);}
    else if(mode===2) {type=2;divisor=2;for(let i=0;i+1<n;i+=2)indices.push(i,i+1);}
    else if(mode===3 || mode===4)
    {type=2;divisor=2;for(let i=0;i+1<n;i++)indices.push(i,i+1);if(mode===3 && n>1)indices.push(n-1,0);}
    else if(mode===5) {for(let i=0;i+2<n;i+=3)indices.push(i,i+1,i+2);}
    else if(mode===6) {for(let i=0;i+2<n;i++)indices.push(i+(i&1),i+(1-(i&1)),i+2);}
    else if(mode===7 || mode===10) {for(let i=1;i+1<n;i++)indices.push(0,i,i+1);}
    else if(mode===8) {for(let i=0;i+3<n;i+=4)indices.push(i,i+1,i+2,i,i+2,i+3);}
    else if(mode===9) {for(let i=0;i+3<n;i+=2)indices.push(i,i+1,i+3,i,i+3,i+2);}
    else throw new RangeError("NV40 invalid primitive mode");
    const bytes=new Uint8Array(indices.length*vertices.stride);
    indices.forEach((index,i)=>bytes.set(vertices.bytes.subarray(index*vertices.stride,(index+1)*vertices.stride),i*vertices.stride));
    return {bytes,stride:vertices.stride,count:indices.length,primitive:type,primitives:indices.length/divisor};
}

export class NV40Render
{
    constructor(engine,renderer)
    {
        this.engine=engine;this.device=engine.device;this.renderer=renderer;this.textures=new NV40Texture(engine.state);
        this.writer=new D9WGWriter(0x3034564E); // "NV40", separate resource namespace
        this.query=0;this.next=2;this.sequence=0;this.request=0;this.created=false;
        this.resources=new Map();this.shaders=new Map();this.declarations=new Map();
        this.batch=null;this.pending=null;this.stats={batches:0,draws:0,bytes:0,readbacks:0,failures:0,uploads:0,uploadBytes:0};
        renderer["listen"](message=>this.receive(message));
    }
    reset()
    {
        if(this.pending) this.pending.resolve();
        this.batch=null;this.pending=null;this.writer=new D9WGWriter(0x3034564E);this.created=false;this.resources.clear();this.shaders.clear();this.declarations.clear();
        this.query=0;this.next=2;this.renderer["post"]({"type":"reset"});
    }
    wait() {this.flush();return this.pending?this.pending.promise.then(()=>this.wait()):Promise.resolve();}
    command(op,fields={}) {return this.writer.command(op,{"device_handle":1,...fields});}
    initialize()
    {
        if(this.created) return;
        this.command(OP.CREATE_DEVICE,{"width":1,"height":1,"backbuffer_format":21,"windowed":1,"behavior_flags":0x20});
        this.created=true;
    }
    target(surface,bytes,usage=1)
    {
        const images=Array.isArray(bytes)?bytes:[bytes],levels=surface.cube?surface.level_count:images.length;
        const key=JSON.stringify([surface.dma,surface.offset,surface.pitch,surface.width,surface.height,surface.d3d,surface.swizzle,surface.u,surface.v,levels,usage,!!surface.cube,!!surface.volume,surface.depth]);
        let resource=this.resources.get(key);
        if(!resource)
        {
            if(this.resources.size>=64)
            {
                const first=[...this.resources].find(([,resource])=>!this.batch?.outputs.has(resource.handle));
                if(!first)throw new RangeError("NV40 pending target cache is full");
                this.writer.command(OP.DESTROY_RESOURCE,{"resource_handle":first[1].handle,"resource_kind":first[1].kind});this.resources.delete(first[0]);
            }
            resource={handle:this.next++,kind:surface.cube?4:surface.volume?5:3,images:null};
            this.resources.set(key,resource);
            this.command(surface.cube?OP.CREATE_TEXTURE_CUBE:surface.volume?OP.CREATE_TEXTURE_VOLUME:OP.CREATE_TEXTURE_2D,
                {"resource_handle":resource.handle,...(surface.cube?{"edge_length":surface.width}:{"width":surface.width,"height":surface.height,...(surface.volume?{"depth":surface.depth}:{})}),
                    "level_count":levels,"format":surface.d3d,"usage":usage});
        }
        // Refresh recency on every use. A frequently bound color/depth target
        // must survive eviction while new sampled textures fill the cache.
        this.resources.delete(key);this.resources.set(key,resource);
        const handle=resource.handle;
        images.forEach((bytes,index)=>{
            if(resource.images && equal_bytes(resource.images[index],bytes))return;
            const level=index%levels,face=surface.cube?Math.floor(index/levels):0;
            const width=Math.max(1,surface.width>>>level),height=Math.max(1,surface.height>>>level);
            const w=this.writer.command(OP.UPDATE_TEXTURE,{"resource_handle":handle,"level":level,"z":face,"width":width,"height":height,
                "depth":surface.volume?Math.max(1,surface.depth>>>level):1,"row_pitch":width*surface.bpp,"data_bytes":bytes.length});
            w.patch_field("data_offset",w.data(bytes));this.stats.uploads++;this.stats.uploadBytes+=bytes.length;
        });
        resource.images=images;
        return handle;
    }
    shader(code,vertex)
    {
        const key=(vertex?"v":"p")+Array.from(code).join(",");
        if(this.shaders.has(key))
        {
            const handle=this.shaders.get(key);this.shaders.delete(key);this.shaders.set(key,handle);return handle;
        }
        if(this.shaders.size>=256)
        {
            const first=this.shaders.entries().next().value;
            this.writer.command(OP.DESTROY_RESOURCE,{"resource_handle":first[1],"resource_kind":first[0][0]==="v"?7:8});this.shaders.delete(first[0]);
        }
        const handle=this.next++;this.shaders.set(key,handle);
        let hash=0xCBF29CE484222325n;
        for(const byte of data(code)) hash=(hash^BigInt(byte))*0x1000001B3n&0xFFFFFFFFFFFFFFFFn;
        const w=this.command(vertex?OP.CREATE_VERTEX_SHADER:OP.CREATE_PIXEL_SHADER,{"resource_handle":handle,
            "instruction_token_count":code.length,"bytecode_hash_low":Number(hash&0xFFFFFFFFn),"bytecode_hash_high":Number(hash>>32n)});
        w.patch_field("code_offset",w.data(data(code)));return handle;
    }
    constants(op,index,values)
    {
        const w=this.command(op,{"start_register":index,"vector_count":values.byteLength/16});
        w.patch_field("data_offset",w.data(data(values)));
    }
    declaration(inputs)
    {
        const key=inputs.map(([index])=>index).join(",");
        if(this.declarations.has(key)) return this.declarations.get(key);
        const handle=this.next++;this.declarations.set(key,handle);
        const w=this.command(OP.CREATE_VERTEX_DECLARATION,{"resource_handle":handle,"element_count":inputs.length});
        inputs.forEach(([attribute],slot)=>w.struct("VertexElement",{"stream":0,"offset":slot*16,"type":3,"usage":5,"usage_index":attribute}));
        return handle;
    }
    render_state(state,value) {this.command(OP.SET_RENDER_STATE,{"state":state,"value":value});}
    range(surface,texture=false)
    {
        const dma=surface.dma;if(!dma.linear)return {memory:dma.target?1:0,first:0,last:Infinity};
        let length=0;
        if(texture)
        {
            for(let level=0;level<surface.levels;level++)
            {
                const width=Math.max(1,surface.width>>>level),height=Math.max(1,surface.height>>>level),depth=Math.max(1,surface.depth>>>level);
                length+=surface.block?Math.ceil(height/4)*(surface.swizzle?Math.ceil(width/4)*surface.block:surface.pitch):
                    surface.swizzle?2**(Math.max(0,surface.u-level)+Math.max(0,surface.v-level)+Math.max(0,surface.w-level))*surface.bpp:
                        height*depth*surface.pitch;
            }
            if(surface.cube)length=(surface.swizzle?Math.ceil(length/128)*128:length)*6;
        }
        else length=surface.swizzle?2**(surface.u+surface.v)*surface.bpp:(surface.height-1)*surface.pitch+surface.width*surface.bpp;
        const first=((dma.pte&0xFFFFF000)>>>0)+dma.adjust+surface.offset;
        return {memory:dma.target?1:0,first,last:first+length};
    }
    barrier(o,method,value)
    {
        if(!this.batch)return false;
        if(o.class_id!==0x4097 || method===0x100 && value || [0x104,0x108,0x110,0x17C8,0x17CC,0x1800,0x1D70,0x1D74,0x1D94].includes(method) || method>=0x120 && method<=0x130)return true;
        if(get(o,method)!==value && (method>=0x180 && method<=0x1B8 || method>=0x200 && method<=0x22C || method>=0x280 && method<=0x28C))return true;
        return false;
    }
    draw(o,mode,words,indices=null,subc=0)
    {
        if(this.pending) throw new RangeError("NV40 renderer already busy");
        const enable=get(o,0x220,1),active=enable&15;
        if(enable&~31 || !(active&1) || active!==1 && !(enable&16))throw new RangeError("NV40 unsupported render target enable mask");
        for(let i=1;i<4;i++)if(active&1<<i && !!(get(o,0x36C)&1<<i)!==!!get(o,0x310))
            throw new RangeError("NV40 independent MRT blending is not connected");
        const zsa=nv40_depth_state(o,(get(o,0x208)>>>5&7)===2,mode);
        if(get(o,0x142C) || get(o,0x374) || get(o,0x1478) ||
            get(o,0x1828,0x1B02)!==0x1B02 || get(o,0x182C,0x1B02)!==0x1B02)
            throw new RangeError("NV40 raster state is not connected");
        const blend=nv40_blend_state(o);
        const cull=nv40_cull_state(o);
        const target=this.engine.state.target(o);
        if(![21,22,23,113].includes(target.d3d)) throw new RangeError("NV40 target format is not connected to renderer");
        const colors=Array.from({length:4},(_,index)=>active&1<<index?this.engine.state.target(o,index):null);
        const viewport=this.engine.state.viewport(o,target);
        const x=get(o,0x8C0),y=get(o,0x8C4),clip=viewport.clip;
        const scissor={left:Math.max(x&65535,clip?clip.left:0),top:Math.max(y&65535,clip?clip.top:0),
            right:Math.min((x&65535)+(x>>>16),clip?clip.right:target.width),
            bottom:Math.min((y&65535)+(y>>>16),clip?clip.bottom:target.height)};
        if(scissor.left>=scissor.right || scissor.top>=scissor.bottom)return;
        const samplers=Array.from({length:16},(_,unit)=>{const format=get(o,0x1A04+unit*32);return format&4?3:(format>>>4&15)===3?4:2;});
        const sampler_1d=Array.from({length:16},(_,unit)=>(get(o,0x1A04+unit*32)>>>4&15)===1);
        const texture_sizes=Array.from({length:16},(_,unit)=>{
            const format=get(o,0x1A04+unit*32),size=get(o,0x1A18+unit*32);
            return format&0x4000?[size>>>16,(format>>>4&15)===1?1:size&65535,(format>>>4&15)===3?get(o,0x1840+unit*4)>>>20:1]:null;
        });
        const vertex_textures=Array.from({length:4},(_,unit)=>{
            const at=0x900+unit*32,enable=get(o,at+12);
            return {dimension:get(o,at+4)>>>4&3,code:get(o,at+4)>>>8&31,bias:(get(o,at+20)<<19>>19)/256,
                min_lod:(enable>>>19&4095)/256,max_lod:(enable>>>7&4095)/256};
        });
        const depth_samplers=Array.from({length:16},(_,unit)=>{
            const at=0x1A00+unit*32,code=get(o,at+4)>>>8&31;
            return [16,18].includes(code)?{compare:get(o,at+8)>>>28,crossbar:get(o,at+16)}:null;
        });
        const control=get(o,0x1D60);
        const shaders=this.engine.shaders(o,{viewport,targets:enable&16?4:1,depth:!!(control&14),fp32_outputs:!!(control&64),
            samplers,sampler_1d,texture_sizes,vertex_textures,depth_samplers});
        const textures=shaders.fragment.samplers.map(([unit])=>{
            const surface=this.textures.describe(o,unit),bytes=this.textures.images(surface);
            return {unit,surface,bytes};
        });
        for(const [unit]of shaders.vertex.samplers)
        {
            const surface=this.textures.vertex(o,unit);
            textures.push({unit:257+unit,surface,bytes:this.textures.images(surface)});
        }
        if(this.batch && textures.some(({surface})=>{
            const source=this.range(surface,true);
            return [...this.batch.outputs.values()].some(({target})=>{
                const destination=this.range(target);
                return source.memory===destination.memory && source.first<destination.last && destination.first<source.last;
            });
        })) {this.flush();return false;}
        const fetched=indices?this.engine.state.array_vertices(o,indices,shaders.vertex.inputs):
            this.engine.state.inline_vertices(o,words,shaders.vertex.inputs);
        const vertices=expand_primitives(fetched,mode);if(!vertices.count || cull.all && vertices.primitive===4)return;
        const initial=colors.map(surface=>{
            if(!surface)return null;
            this.engine.state.validate(surface,true);return this.engine.state.read(surface);
        });
        let depth=null,depthBytes=null;
        if(zsa.enabled)
        {
            depth=this.engine.state.target(o,0,true);this.engine.state.validate(depth,true);
            if(zsa.stencil && depth.d3d!==75)throw new RangeError("NV40 stencil needs D24S8");
            depthBytes=this.engine.state.read(depth);
        }
        // Everything that can fault on guest state is checked before emitting
        // commands or changing the host's resource cache.
        if(!this.batch)this.batch={channel:o.channel,subc,outputs:new Map(),draws:0,query:null};
        this.initialize();const handles=colors.map((surface,index)=>surface?this.target(surface,initial[index]):0),
            vs=this.shader(shaders.vertex.bytecode,true),ps=this.shader(shaders.fragment.bytecode,false);
        handles.forEach((handle,index)=>this.command(OP.SET_RENDER_TARGET,{"target_index":index,"color_texture_handle":handle}));
        const depthHandle=depth?this.target(depth,depthBytes,2):0;
        this.command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL,{"depth_texture_handle":depthHandle});
        this.command(OP.SET_VIEWPORT,{"x":viewport.x,"y":viewport.y,"width":viewport.width,"height":viewport.height,"max_z":1});
        this.command(OP.SET_VERTEX_DECLARATION,{"declaration_handle":this.declaration(shaders.vertex.inputs)});
        for(const {unit,surface,bytes}of textures)
        {
            const image=this.target({...surface,bpp:surface.upload_bpp},bytes,0);
            this.command(OP.SET_TEXTURE,{"stage":unit,"texture_handle":image});
            for(const [state,value]of [[1,surface.wrap_s],[2,surface.wrap_t],[3,surface.wrap_r||3],[4,surface.border],[5,surface.mag],[6,surface.min],
                [7,surface.mip],[8,surface.bias],[9,surface.min_lod],[10,1],[11,+!!surface.srgb],
                // Private NV sampler states, within the stage's 64-entry bank.
                [62,float_word(surface.lod_min||0)],[63,float_word(surface.lod_max??surface.level_count-1)]])
                this.command(OP.SET_SAMPLER_STATE,{"sampler":unit,"state":state,"value":value});
        }
        this.command(OP.SET_VERTEX_SHADER,{"shader_handle":vs});this.command(OP.SET_PIXEL_SHADER,{"shader_handle":ps});
        this.constants(OP.SET_VERTEX_SHADER_CONSTANT_F,0,this.engine.vertex_constants(o,0,544));
        for(const [index,values]of shaders.vertex.viewport_constants)this.constants(OP.SET_VERTEX_SHADER_CONSTANT_F,index,values);
        for(const [index,values]of shaders.vertex.texture_constants)this.constants(OP.SET_VERTEX_SHADER_CONSTANT_F,index,values);
        shaders.fragment.constant_values.forEach((values,index)=>this.constants(OP.SET_PIXEL_SHADER_CONSTANT_F,index,values));
        for(const [index,values]of shaders.fragment.texture_constants)this.constants(OP.SET_PIXEL_SHADER_CONSTANT_F,index,values);
        this.render_state(22,cull.state);for(const [state,value]of zsa.states)this.render_state(state,value);
        for(const [state,value]of blend)this.render_state(state,value);
        const mask=get(o,0x324,0x01010101);
        this.render_state(168,(mask&0x10000?1:0)|(mask&0x100?2:0)|(mask&1?4:0)|(mask&0x1000000?8:0));
        const mrtMask=get(o,0x370);
        for(let index=1;index<4;index++)
        {
            const bits=mrtMask>>>(index*4)&15;
            this.render_state(189+index,(bits&2?1:0)|(bits&4?2:0)|(bits&8?4:0)|(bits&1?8:0));
        }
        this.render_state(174,1);this.render_state(9,get(o,0x368,0x1D01)===0x1D00?1:2);this.render_state(26,get(o,0x300));
        this.command(OP.SET_SCISSOR_RECT,scissor);
        this.command(OP.BEGIN_SCENE);
        let query=null;
        if(get(o,0x17CC))
        {
            if(!this.query)
            {
                this.query=this.next++;
                this.command(OP.CREATE_QUERY,{"resource_handle":this.query,"query_type":9,"response_offset":0});
            }
            query={object:o,id:++this.request,value:null};
            this.command(OP.BEGIN_QUERY,{"resource_handle":this.query,"response_offset":0,"request_id":query.id});
        }
        const w=this.command(OP.DRAW_PRIMITIVE_UP,{"primitive_type":vertices.primitive,"primitive_count":vertices.primitives,
            "stride":vertices.stride,"vertex_count":vertices.count,"vertex_bytes":vertices.bytes.length});
        w.patch_field("vertex_data_offset",w.data(vertices.bytes));
        if(query)this.command(OP.END_QUERY,{"resource_handle":this.query,"response_offset":0,"request_id":query.id});
        this.command(OP.END_SCENE);
        colors.forEach((target,index)=>{if(target)this.batch.outputs.set(handles[index],{target,handle:handles[index]});});
        if(depth)this.batch.outputs.set(depthHandle,{target:depth,handle:depthHandle});
        this.batch.query=query;this.batch.draws++;this.stats.draws++;
        if(query || this.batch.draws>=32 || this.writer.size()>=(8<<20) || !this.device.fifo?.running)this.flush();
    }
    flush()
    {
        if(!this.batch || this.pending)return;
        const batch=this.batch;this.batch=null;
        let resolve;const promise=new Promise(done=>{resolve=done;});
        const outputs=[...batch.outputs.values()].map(output=>({...output,bytes:new Uint8Array(output.target.width*output.target.height*output.target.bpp)}));
        const pending=this.pending={channel:batch.channel,subc:batch.subc,outputs,query:batch.query,requests:new Map(),promise,resolve,sequence:++this.sequence};
        outputs.forEach((output,index)=>{
            const {target,handle}=output,pitch=target.width*target.bpp,rows=Math.max(1,Math.floor(READBACK_MAX_BYTES/pitch));
            for(let first=0;first<target.height;first+=rows)
            {
                const count=Math.min(rows,target.height-first),id=++this.request;
                pending.requests.set(id,{output:index,offset:first*pitch,bytes:count*pitch});
                this.command(OP.READBACK_SURFACE,{"texture_handle":handle,"format":target.d3d,"width":target.width,"height":target.height,
                    "first_row":first,"row_count":count,"destination_pitch":pitch,"destination_bytes":count*pitch,"response_offset":QUERY_REGION_BYTES,"request_id":id});
            }
        });
        const bytes=this.writer.finish(this.sequence,0);this.stats.batches++;this.stats.bytes+=bytes.length;
        this.renderer["post"]({"type":"submit","seq":this.sequence,"bytes":bytes},[bytes.buffer]);
    }
    fail(reason)
    {
        const pending=this.pending;if(!pending)return;
        this.pending=null;this.stats.failures++;
        for(const resource of this.resources.values())resource.images=null;
        this.device.graph.error(pending.channel,pending.subc,0x1808,0,0x100,0x4000,"NV40 renderer: "+reason);
        pending.resolve();this.device.machine.wake();
    }
    receive(message)
    {
        const pending=this.pending;if(!pending)return;
        if(message["type"]==="lost") {this.fail(message["reason"]);return;}
        if(message["type"]==="write")
        {
            const bytes=message["bytes"];if(bytes.length<16)return;
            const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),id=view.getUint32(0,true),request=pending.requests.get(id);
            if(pending.query && id===pending.query.id)
            {
                if(view.getUint32(12,true)!==RESPONSE_OK) {this.fail("invalid occlusion query readback");return;}
                pending.query.value=view.getUint32(4,true);return;
            }
            if(!request)return;
            if(view.getUint32(12,true)!==RESPONSE_OK || view.getUint32(4,true)!==request.bytes || bytes.length<16+request.bytes)
            {this.fail("invalid target readback");return;}
            pending.outputs[request.output].bytes.set(bytes.subarray(16,16+request.bytes),request.offset);pending.requests.delete(id);this.stats.readbacks++;
        }
        else if(message["type"]==="done" && message["seq"]===pending.sequence)
        {
            if(pending.query && pending.query.value===null) {this.fail("GPU completed without occlusion query readback");return;}
            if(pending.requests.size) {this.fail("GPU completed without target readback");return;}
            try
            {
                for(const {target}of pending.outputs)this.engine.state.validate(target,true);
                for(const {target,bytes}of pending.outputs)this.engine.state.write(target,bytes);
                // The GPU still holds these exact readback pixels. Future guest
                // reads/writes remain authoritative and are compared bytewise.
                for(const {handle,bytes}of pending.outputs)
                    for(const resource of this.resources.values())if(resource.handle===handle)resource.images=[bytes];
            }
            catch(error) {this.fail(String(error));return;}
            if(pending.query)
            {
                const {object,value}=pending.query;
                object.methods.set(QUERY_COUNT,(get(object,QUERY_COUNT)+value)>>>0);
            }
            this.pending=null;pending.resolve();this.device.machine.wake();this.device.fifo.run();
        }
    }
}
