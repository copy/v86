// NV40 PGRAPH objects and notifications. Original implementation using the MIT
// envytools rnndb graph/nv1_ctxobj.xml, fifo/nv_object.xml and Nouveau nv40.c.
import { NV2D } from "./nv_2d.js";
import { NV40_3D } from "./nv40_3d.js";
const CONTEXT_METHODS = new Map([
    [0x12, [0x300]], [0x72, [0x300]], [0x19, [0x300, 0x304]], [0x43, [0x300]],
    [0x57, [0x300, 0x304]], [0x44, [0x300, 0x304, 0x308, 0x30C, 0x310, 0x314, 0x318, 0x31C]],
    [0x42, [0x184, 0x188, 0x300, 0x304, 0x308, 0x30C]],
    [0x62, [0x184, 0x188, 0x300, 0x304, 0x308, 0x30C]],
    [0x362, [0x184, 0x188, 0x300, 0x304, 0x308, 0x30C]],
    [0x3062, [0x184, 0x188, 0x300, 0x304, 0x308, 0x30C]],
    [0x52, [0x184, 0x300, 0x304]], [0x9E, [0x184, 0x300, 0x304]],
    [0x309E, [0x184, 0x300, 0x304]],
    [0x38, [0x184, 0x188, 0x18C]], [0x88, [0x184, 0x188, 0x18C]],
]);

export class NVGraph
{
    constructor(device)
    {
        this.device = device;
        this.objects = new Map();
        this.program = new Map();
        this.faults = [];
        this.flips = [[0,0,0,0],[0,0,0,0]];
        this.flip_contexts = new Map();this.context = 0;this.flip_offset=-2;
        this.engine2d = new NV2D(this);
        this.engine3d = new NV40_3D(this);
    }

    reset() { this.flip_offset=-2;this.flip_contexts.clear();this.context=0; this.flips = [[0,0,0,0],[0,0,0,0]]; this.objects.clear(); this.program.clear(); this.engine3d.captured.clear(); if(this.engine3d.backend) this.engine3d.backend.reset(); }
    get busy()
    {
        if(this.context && !(this.reg(0x40032C)&0x01000000))this.transfer_flips(this.context,false);
        return this.engine3d.busy || this.flips.some(f=>!!f[3]);
    }
    reg(at) { return this.device.registers.get(at) || 0; }
    set(at, value) { this.device.registers.set(at, value >>> 0); }
    implemented(at)
    {
        return [0x400100, 0x400104, 0x400108, 0x40013C, 0x400300, 0x400304,
            0x400310, 0x400784, 0x400324, 0x400328, 0x40032C, 0x400330, 0x400700, 0x400704, 0x400708, 0x400710, 0x40071C, 0x400720].includes(at);
    }

    read(at)
    {
        // FLIP_WAIT blocks the FIFO front end, while the raster engine can be
        // idle. The display ISR must be able to save that idle context before
        // advancing its READ counter.
        if(at === 0x400700) return this.engine3d.busy ? 1 : 0;
        if(at === 0x400710)
        {
            let value=this.reg(at)&~0x77777700;
            for(let i=0;i<2;i++)
            {
                const [read,write,modulo]=this.flips[i],shift=8+i*12;
                value|=write<<shift|read<<(shift+4)|modulo<<(shift+8);
            }
            return value>>>0;
        }
        if(at === 0x40071C) return 0;
        if(at === 0x400328) return this.program.get(this.reg(0x400324)) || 0;
        return null;
    }

    written(at, value)
    {
        if(at === 0x400710)
        {
            for(let i=0;i<2;i++)
            {
                const f=this.flips[i],shift=8+i*12;
                f[0]=value>>>(shift+4)&7;f[1]=value>>>shift&7;f[2]=value>>>(shift+8)&7;
                if(f[0]!==f[1])f[3]=0;
            }
        }
        if(at === 0x40071C)
        {
            // The display ISR acknowledges completed flips by advancing the
            // corresponding 2D/3D read counter, independently of GPU draws.
            for(let i=0;i<2;i++)if(value & 1<<i)
            {
                const flip=this.flips[i];flip[0]=this.increment_flip(flip[0],flip[2]);
                if(flip[0]!==flip[1])flip[3]=0;
            }
            this.set(at,0);
            if(this.device.machine)this.device.machine.wake();
            if(this.device.fifo)this.device.fifo.run();
        }
        if(at === 0x400100 && value & 0x10001)
        {
            const clear = (value & 1 ? 0xFFFF7FFF : 0) | (value & 0x10000 ? 0x8000 : 0);
            this.set(0x400108, this.reg(0x400108) & ~clear);
            if(value & 1) this.set(0x400104, 0);
        }
        if(at === 0x400328)
        {
            this.flip_offset=-2;
            this.program.set(this.reg(0x400324), this.reg(at));
            this.set(0x400324, this.reg(0x400324) + 1);
        }
        // The host saves/restores decoded contexts by channel. Keep uploaded
        // context microcode for readback, without executing foreign firmware.
        if(at === 0x400304 && value & 1)
        {
            const flags=this.reg(0x400310),instance=this.reg(0x400784)&0xFFFFF;
            if(flags&0x20)this.transfer_flips(instance,true);
            if(flags&0x40)this.transfer_flips(instance,false);
            this.set(0x400310,flags&~0x60);
            this.set(0x400300,this.reg(0x400300)&~1);
        }
    }

    object(channel, instance)
    {
        const key = channel + ":" + instance, class_id = this.device.dma.word(instance) & 0xFFFF;
        let object = this.objects.get(key);
        if(!object || object.class_id !== class_id)
        {
            object = { channel, instance, class_id, methods: new Map(), stream: [] };
            this.objects.set(key, object);
        }
        return object;
    }

    error(channel, subc, method, value, source = 0x40, status = 0x4000, reason = "unimplemented PGRAPH method")
    {
        this.faults.push({channel,subc,method,value:value>>>0,source,status,reason,sequence:this.device.trace.sequence});
        if(this.faults.length>64)this.faults.shift();
        this.set(0x400704, channel << 20 | subc << 16 | method);
        this.set(0x400708, value);
        this.set(0x400108, this.reg(0x400108) | source);
        this.set(0x400104, this.reg(0x400104) | status);
        this.set(0x400100, this.reg(0x400100) | 1);
        this.set(0x400720, this.reg(0x400720) & ~1);
        this.device.update_irq();
    }

    notification(object, offset, awaken)
    {
        if(!object.methods.has(0x180)) throw new RangeError("NV notifier DMA unbound");
        const dma = this.device.dma.descriptor(object.methods.get(0x180) * 16);
        const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
        /** @type {bigint} */
        const time = this.device.time();
        view.setUint32(0, Number(time & 0xFFFFFFFFn), true);
        view.setUint32(4, Number(time >> 32n), true);
        this.device.dma.write(dma, offset, bytes);
        if(awaken)
        {
            this.set(0x400108, this.reg(0x400108) | (offset ? 0x8000 : 1));
            this.set(0x400100, this.reg(0x400100) | (offset ? 0x10000 : 1));
            this.device.update_irq();
        }
    }

    flip_context_offset()
    {
        // Decode only the declarative register-transfer layout. No branches,
        // calls, resets or guest microcode are executed. NV40 REG consumes a
        // literal count (or RA), CMD SET_CTX_POINTER starts a memory block.
        if(this.flip_offset!==-2)return this.flip_offset<0?null:this.flip_offset;
        let pointer=0,ra=0;
        for(const [,word]of [...this.program].sort((a,b)=>a[0]-b[0]))
        {
            if(word>>>20===2)ra=word&0xFFFFF;
            else if(word===0x60000A)pointer=ra;
            else if(word>>>20===1)
            {
                const count=word>>>14&63 || ra,address=(word&0x3FFF)*4+0x400000;
                if(address<=0x400710 && address+count*4>0x400710)
                {this.flip_offset=pointer*4+0x400710-address;return this.flip_offset;}
                pointer+=count;
            }
        }
        this.flip_offset=-1;return null;
    }
    transfer_flips(instance,save)
    {
        const offset=this.flip_context_offset(),at=instance*16+offset;
        if(!instance || offset===null || at<0 || at+4>1<<20)return;
        const vram=this.device.vram(),base=this.device.vram_size-(1<<20)+at;
        const view=new DataView(vram.buffer,vram.byteOffset+base,4);
        if(save)
        {
            view.setUint32(0,(view.getUint32(0,true)&~0x77777700)|(this.read(0x400710)&0x77777700),true);
            this.device.machine.mmio_ram_mark_dirty(this.device.vga.lfb_region);
        }
        else
        {
            const word=view.getUint32(0,true);
            for(let i=0;i<2;i++)
            {
                const f=this.flips[i],shift=8+i*12;
                f[0]=word>>>(shift+4)&7;f[1]=word>>>shift&7;f[2]=word>>>(shift+8)&7;
                if(f[0]!==f[1])f[3]=0;
            }
        }
    }
    activate_context()
    {
        const instance=this.reg(0x32E0)&0xFFFFF;
        if(!instance)return;
        if(instance!==this.context)
        {
            if(this.context)
            {
                this.transfer_flips(this.context,true);
                this.flip_contexts.set(this.context,this.flips);
            }
            this.flips=this.flip_contexts.get(instance)||[[0,0,0,0],[0,0,0,0]];
            this.context=instance;this.transfer_flips(instance,false);
        }
        else if(!(this.reg(0x40032C)&0x01000000))this.transfer_flips(instance,false);
        this.set(0x40032C,0x01000000|instance);
    }
    increment_flip(value,modulo) { return value+1===modulo?0:(value+1)&7; }
    flip_method(object,method,value)
    {
        const flip=this.flips[object.class_id===0x4097?1:0];
        if(method<=0x128)
        {
            if(value>7)throw new RangeError("NV40 invalid flip counter");
            flip[(method-0x120)/4]=value;
        }
        else if(method===0x12C)flip[1]=this.increment_flip(flip[1],flip[2]);
        else flip[3]=+(flip[0]===flip[1]);
    }

    method(channel, subc, instance, method, value)
    {
        if(!(this.reg(0x200) & 0x1000) || !(this.reg(0x400720) & 1)) return false;
        let object, accepted = false;
        try
        {
            this.activate_context();
            object = this.object(channel, instance);
            if(this.engine3d.backend?.barrier(object,method,value))
            {this.engine3d.backend.flush();return false;}

            accepted = method === 0x100 || method === 0x108 || method === 0x10C;
            if(method===0x100 && object.class_id===0x4097 && value && (this.reg(0x40008C)&0x100000))
            {
                this.error(channel,subc,method,value,2,0x2000,"nonzero NOP on a non-synchronous 3D object");
                accepted=true;
            }
            else if(method === 0x104)
            {
                if(value > 1) this.error(channel, subc, method, value, 2, 0x2000, "invalid notification mode");
                else this.notification(object, 0, value === 1);
                accepted = true;
            }
            else if([0x4097,0x9F].includes(object.class_id) && method>=0x120 && method<=0x130 && !(method&3))
            {this.flip_method(object,method,value);accepted=true;}
            else if(method === 0x180) accepted = true;
            else if(CONTEXT_METHODS.has(object.class_id))
            {
                accepted = accepted || CONTEXT_METHODS.get(object.class_id).includes(method);
                if(object.class_id === 0x44) accepted = accepted || method >= 0x400 && method < 0x440 ||
                    method >= 0x500 && method < 0x580 || method >= 0x600 && method < 0x680 || method >= 0x700 && method < 0x800;
            }
            else if(object.class_id === 0x4097) accepted = accepted || this.engine3d.method(object, method, value, subc);
            else if(this.engine2d) accepted = accepted || this.engine2d.method(object, method, value);
            if(accepted===null)return false;
            if(accepted) object.methods.set(method, value >>> 0);
            else this.error(channel, subc, method, value);
            this.device.trace.record("graph", object.class_id * 0x2000 + method, 4, true, value, accepted);
        }
        catch(error)
        {
            if(!(error instanceof RangeError)) throw error;
            this.error(channel, subc, method, value, 0x100, 0x4000, error.message);
        }
        if(object) this.device.trace.record_method(channel, subc, instance, object.class_id, method, value, accepted);
        // A trapped method has reached PGRAPH and is consumed. FIFO access is
        // stopped above until the guest acknowledges and re-enables the engine.
        return true;
    }

    get_state()
    {
        return [3, Array.from(this.objects.values(), o => [o.channel, o.instance, o.class_id, Array.from(o.methods), o.stream]),
            Array.from(this.program),this.flips.map(f=>f.slice()),this.context,
            Array.from(this.flip_contexts,([instance,flips])=>[instance,flips.map(f=>f.slice())])];
    }
    set_state(state)
    {
        this.reset();
        for(const [channel, instance, class_id, methods, stream] of state[1])
            this.objects.set(channel + ":" + instance, { channel, instance, class_id, methods: new Map(methods), stream });
        this.program = new Map(state[2]);
        if(state[0]>=2)this.flips=state[3].map(f=>f.slice());
        if(state[0]>=3)
        {
            this.context=state[4];
            this.flip_contexts=new Map(state[5].map(([instance,flips])=>[instance,flips.map(f=>f.slice())]));
        }
        else if(this.reg(0x32E0)&0xFFFFF)
        {
            // v2 stored the active counters without naming their context.
            this.context=this.reg(0x32E0)&0xFFFFF;
            this.set(0x40032C,0x01000000|this.context);
        }
    }
}
