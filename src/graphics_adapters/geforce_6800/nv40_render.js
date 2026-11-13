// Hardware method draws -> the shared D9WG/WebGPU executor. VRAM remains the
// snapshot authority: every submitted target is downloaded before FIFO resumes.
import {D9WGWriter} from "../vmware_svga/svga3d_d9wg.js";
import {OP} from "../vmware_svga/d9wg_constants.js";
import {QUERY_REGION_BYTES,READBACK_MAX_BYTES,RESPONSE_OK} from "../renderer_protocol.js";
const get=(o,at,fallback=0)=>o.methods.has(at)?o.methods.get(at):fallback;
const data=typed=>new Uint8Array(typed.buffer,typed.byteOffset,typed.byteLength);

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
        this.engine=engine;this.device=engine.device;this.renderer=renderer;
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
    target(surface,bytes)
    {
        const key=JSON.stringify([surface.dma,surface.offset,surface.pitch,surface.width,surface.height,surface.d3d,surface.swizzle,surface.u,surface.v]);
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
                "level_count":1,"format":surface.d3d,"usage":1});
        }
        const w=this.writer.command(OP.UPDATE_TEXTURE,{"resource_handle":handle,"width":surface.width,"height":surface.height,
            "depth":1,"row_pitch":surface.width*surface.bpp,"data_bytes":bytes.length});
        w.patch_field("data_offset",w.data(bytes));
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
        if(get(o,0x220,1)!==1) throw new RangeError("NV40 MRT rendering is not connected");
        if(get(o,0xA74) || get(o,0x328) || get(o,0x348)) throw new RangeError("NV40 depth/stencil rendering is not connected");
        if(get(o,0x183C) || get(o,0x142C) || get(o,0x374) || get(o,0x1478) || get(o,0x36C) ||
            get(o,0x1828,0x1B02)!==0x1B02 || get(o,0x182C,0x1B02)!==0x1B02)
            throw new RangeError("NV40 raster state is not connected");
        if(get(o,0x304) || get(o,0x310)) throw new RangeError("NV40 alpha/blend rendering is not connected");
        const target=this.engine.state.target(o);
        if(![21,22,23].includes(target.d3d)) throw new RangeError("NV40 target format is not connected to renderer");
        if(!(get(o,0x1E94)&0x100)) throw new RangeError("NV40 clip-space viewport lowering is not connected");
        const shaders=this.engine.shaders(o,{viewport:{width:target.width,height:target.height,bypass:true}});
        if(shaders.fragment.samplers.length) throw new RangeError("NV40 texture sampling is not connected");
        const fetched=indices?this.engine.state.array_vertices(o,indices,shaders.vertex.inputs):
            this.engine.state.inline_vertices(o,words,shaders.vertex.inputs);
        const vertices=expand_primitives(fetched,mode);if(!vertices.count)return;
        this.engine.state.validate(target,true);
        const initial=this.engine.state.read(target);
        // Everything that can fault on guest state is checked before emitting
        // commands or changing the host's resource cache.
        this.initialize();const handle=this.target(target,initial),vs=this.shader(shaders.vertex.bytecode,true),ps=this.shader(shaders.fragment.bytecode,false);
        this.command(OP.SET_RENDER_TARGET,{"target_index":0,"color_texture_handle":handle});
        this.command(OP.SET_VIEWPORT,{"width":target.width,"height":target.height,"max_z":1});
        this.command(OP.SET_VERTEX_DECLARATION,{"declaration_handle":this.declaration(shaders.vertex.inputs)});
        this.command(OP.SET_VERTEX_SHADER,{"shader_handle":vs});this.command(OP.SET_PIXEL_SHADER,{"shader_handle":ps});
        this.constants(OP.SET_VERTEX_SHADER_CONSTANT_F,0,this.engine.vertex_constants(o,0,256));
        for(const [index,values]of shaders.vertex.viewport_constants)this.constants(OP.SET_VERTEX_SHADER_CONSTANT_F,index,values);
        shaders.fragment.constant_values.forEach((values,index)=>this.constants(OP.SET_PIXEL_SHADER_CONSTANT_F,index,values));
        this.render_state(7,0);this.render_state(14,0);this.render_state(22,1);this.render_state(27,0);this.render_state(15,0);this.render_state(52,0);
        const mask=get(o,0x324,0x01010101);
        this.render_state(168,(mask&0x10000?1:0)|(mask&0x100?2:0)|(mask&1?4:0)|(mask&0x1000000?8:0));
        this.render_state(174,1);this.render_state(9,get(o,0x368,0x1D01)===0x1D00?1:2);this.render_state(26,get(o,0x300));
        const x=get(o,0x8C0),y=get(o,0x8C4);
        this.command(OP.SET_SCISSOR_RECT,{"left":x&65535,"top":y&65535,
            "right":(x&65535)+(x>>>16),"bottom":(y&65535)+(y>>>16)});
        this.command(OP.BEGIN_SCENE);
        const w=this.command(OP.DRAW_PRIMITIVE_UP,{"primitive_type":vertices.primitive,"primitive_count":vertices.primitives,
            "stride":vertices.stride,"vertex_count":vertices.count,"vertex_bytes":vertices.bytes.length});
        w.patch_field("vertex_data_offset",w.data(vertices.bytes));this.command(OP.END_SCENE);
        let resolve;const promise=new Promise(done=>{resolve=done;});
        const pending=this.pending={channel:o.channel,subc,target,bytes:new Uint8Array(target.width*target.height*target.bpp),requests:new Map(),promise,resolve,sequence:++this.sequence};
        const pitch=target.width*target.bpp,rows=Math.max(1,Math.floor(READBACK_MAX_BYTES/pitch));
        for(let first=0;first<target.height;first+=rows)
        {
            const count=Math.min(rows,target.height-first),id=++this.request;
            pending.requests.set(id,{offset:first*pitch,bytes:count*pitch});
            this.command(OP.READBACK_SURFACE,{"texture_handle":handle,"format":target.d3d,"width":target.width,"height":target.height,
                "first_row":first,"row_count":count,"destination_pitch":pitch,"destination_bytes":count*pitch,"response_offset":QUERY_REGION_BYTES,"request_id":id});
        }
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
            pending.bytes.set(bytes.subarray(16,16+request.bytes),request.offset);pending.requests.delete(id);this.stats.readbacks++;
        }
        else if(message["type"]==="done" && message["seq"]===pending.sequence)
        {
            if(pending.requests.size) {this.fail("GPU completed without target readback");return;}
            try {this.engine.state.write(pending.target,pending.bytes);}
            catch(error) {this.fail(String(error));return;}
            this.pending=null;pending.resolve();this.device.machine.wake();this.device.fifo.run();
        }
    }
}
