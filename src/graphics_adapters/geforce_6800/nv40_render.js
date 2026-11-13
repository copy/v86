// Hardware method draws -> the shared D9WG/WebGPU executor. VRAM remains the
// snapshot authority: every submitted target is downloaded before FIFO resumes.
import {D9WGWriter} from "../vmware_svga/svga3d_d9wg.js";
import {OP} from "../vmware_svga/d9wg_constants.js";
import {NV40Texture} from "./nv40_texture.js";
import {QUERY_REGION_BYTES,READBACK_MAX_BYTES,RESPONSE_OK} from "../renderer_protocol.js";
const get=(o,at,fallback=0)=>o.methods.has(at)?o.methods.get(at):fallback;
const data=typed=>new Uint8Array(typed.buffer,typed.byteOffset,typed.byteLength);
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
export function nv40_depth_state(o)
{
    const depth=!!get(o,0xA74),stencil=!!get(o,0x328);
    if(get(o,0x348) || get(o,0x380) || get(o,0xA60) || get(o,0xA64) || get(o,0xA68))
        throw new RangeError("NV40 two-sided stencil/depth bounds/bias is not connected");
    const result=[[7,+depth],[14,depth?+!!get(o,0xA70):0],[23,depth?comparison(get(o,0xA6C,0x201)):8],[52,+stencil],[185,0]];
    if(stencil)
    {
        for(const [state,at]of [[53,0x33C],[54,0x340],[55,0x344]])
        {
            const operation=get(o,at,0x1E00);
            if(!STENCIL.has(operation))throw new RangeError("NV40 invalid stencil operation");
            result.push([state,STENCIL.get(operation)]);
        }
        result.push([56,comparison(get(o,0x330,0x207))],[57,get(o,0x334)&255],[58,get(o,0x338,255)&255],[59,get(o,0x32C,255)&255]);
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
    if([source&65535,destination&65535].some(value=>value===0x8003 || value===0x8004))
        throw new RangeError("NV40 constant-alpha RGB blend is not connected");
    result.push([19,convert(BLEND,source&65535)],[20,convert(BLEND,destination&65535)],
        [171,convert(EQUATION,equation&65535)],[193,get(o,0x31C)],
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
        this.next=2;this.sequence=0;this.request=0;this.created=false;
        this.resources=new Map();this.shaders=new Map();this.declarations=new Map();
        this.pending=null;this.stats={draws:0,bytes:0,readbacks:0,failures:0};
        renderer["listen"](message=>this.receive(message));
    }
    reset()
    {
        if(this.pending) this.pending.resolve();
        this.pending=null;this.writer=new D9WGWriter(0x3034564E);this.created=false;this.resources.clear();this.shaders.clear();this.declarations.clear();
        this.next=2;this.renderer["post"]({"type":"reset"});
    }
    wait() {return this.pending?this.pending.promise:Promise.resolve();}
    command(op,fields={}) {return this.writer.command(op,{"device_handle":1,...fields});}
    initialize()
    {
        if(this.created) return;
        this.command(OP.CREATE_DEVICE,{"width":1,"height":1,"backbuffer_format":21,"windowed":1});
        this.created=true;
    }
    target(surface,bytes,usage=1)
    {
        const images=Array.isArray(bytes)?bytes:[bytes],levels=images.length;
        const key=JSON.stringify([surface.dma,surface.offset,surface.pitch,surface.width,surface.height,surface.d3d,surface.swizzle,surface.u,surface.v,levels,usage]);
        let handle=this.resources.get(key);
        if(!handle)
        {
            if(this.resources.size>=64)
            {
                const first=this.resources.entries().next().value;
                this.writer.command(OP.DESTROY_RESOURCE,{"resource_handle":first[1],"resource_kind":3});this.resources.delete(first[0]);
            }
            handle=this.next++;this.resources.set(key,handle);
            this.command(OP.CREATE_TEXTURE_2D,{"resource_handle":handle,"width":surface.width,"height":surface.height,
                "level_count":levels,"format":surface.d3d,"usage":usage});
        }
        images.forEach((bytes,level)=>{
            const width=Math.max(1,surface.width>>>level),height=Math.max(1,surface.height>>>level);
            const w=this.writer.command(OP.UPDATE_TEXTURE,{"resource_handle":handle,"level":level,"width":width,"height":height,
                "depth":1,"row_pitch":width*surface.bpp,"data_bytes":bytes.length});
            w.patch_field("data_offset",w.data(bytes));
        });
        return handle;
    }
    shader(code,vertex)
    {
        const key=(vertex?"v":"p")+Array.from(code).join(",");
        if(this.shaders.has(key)) return this.shaders.get(key);
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
    draw(o,mode,words,indices=null,subc=0)
    {
        if(this.pending) throw new RangeError("NV40 renderer already busy");
        const enable=get(o,0x220,1),active=enable&15;
        if(enable&~31 || !(active&1) || active!==1 && !(enable&16))throw new RangeError("NV40 unsupported render target enable mask");
        for(let i=1;i<4;i++)if(active&1<<i && !!(get(o,0x36C)&1<<i)!==!!get(o,0x310))
            throw new RangeError("NV40 independent MRT blending is not connected");
        const zsa=nv40_depth_state(o);
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
        const shaders=this.engine.shaders(o,{viewport,targets:enable&16?4:1,depth:!!(get(o,0x1D60)&14)});
        const textures=shaders.fragment.samplers.map(([unit])=>{
            const surface=this.textures.describe(o,unit),bytes=this.textures.images(surface);
            return {unit,surface,bytes};
        });
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
            for(const [state,value]of [[1,surface.wrap_s],[2,surface.wrap_t],[3,3],[4,surface.border],[5,surface.mag],[6,surface.min],
                [7,surface.mip],[8,surface.bias],[9,surface.min_lod],[10,1],[11,0]])
                this.command(OP.SET_SAMPLER_STATE,{"sampler":unit,"state":state,"value":value});
        }
        this.command(OP.SET_VERTEX_SHADER,{"shader_handle":vs});this.command(OP.SET_PIXEL_SHADER,{"shader_handle":ps});
        this.constants(OP.SET_VERTEX_SHADER_CONSTANT_F,0,this.engine.vertex_constants(o,0,256));
        for(const [index,values]of shaders.vertex.viewport_constants)this.constants(OP.SET_VERTEX_SHADER_CONSTANT_F,index,values);
        shaders.fragment.constant_values.forEach((values,index)=>this.constants(OP.SET_PIXEL_SHADER_CONSTANT_F,index,values));
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
        const w=this.command(OP.DRAW_PRIMITIVE_UP,{"primitive_type":vertices.primitive,"primitive_count":vertices.primitives,
            "stride":vertices.stride,"vertex_count":vertices.count,"vertex_bytes":vertices.bytes.length});
        w.patch_field("vertex_data_offset",w.data(vertices.bytes));this.command(OP.END_SCENE);
        let resolve;const promise=new Promise(done=>{resolve=done;});
        const outputs=[...colors.flatMap((target,index)=>target?[{target,handle:handles[index]}]:[]),
            ...(depth?[{target:depth,handle:depthHandle}]:[])].map(output=>({...output,bytes:new Uint8Array(output.target.width*output.target.height*output.target.bpp)}));
        const pending=this.pending={channel:o.channel,subc,outputs,requests:new Map(),promise,resolve,sequence:++this.sequence};
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
        const bytes=this.writer.finish(this.sequence,0);this.stats.draws++;this.stats.bytes+=bytes.length;
        this.renderer["post"]({"type":"submit","seq":this.sequence,"bytes":bytes},[bytes.buffer]);
    }
    fail(reason)
    {
        const pending=this.pending;if(!pending)return;
        this.pending=null;this.stats.failures++;
        this.device.graph.faults.push({reason:"NV40 renderer: "+reason});
        if(this.device.graph.faults.length>64)this.device.graph.faults.shift();
        this.device.graph.error(pending.channel,pending.subc,0x1808,0,0x100,0x4000);
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
            if(!request)return;
            if(view.getUint32(12,true)!==RESPONSE_OK || view.getUint32(4,true)!==request.bytes || bytes.length<16+request.bytes)
            {this.fail("invalid target readback");return;}
            pending.outputs[request.output].bytes.set(bytes.subarray(16,16+request.bytes),request.offset);pending.requests.delete(id);this.stats.readbacks++;
        }
        else if(message["type"]==="done" && message["seq"]===pending.sequence)
        {
            if(pending.requests.size) {this.fail("GPU completed without target readback");return;}
            try
            {
                for(const {target}of pending.outputs)this.engine.state.validate(target,true);
                for(const {target,bytes}of pending.outputs)this.engine.state.write(target,bytes);
            }
            catch(error) {this.fail(String(error));return;}
            this.pending=null;pending.resolve();this.device.machine.wake();this.device.fifo.run();
        }
    }
}
