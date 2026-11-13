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
        this.engine2d = new NV2D(this);
        this.engine3d = new NV40_3D(this);
    }

    reset() { this.flips = [[0,0,0,0],[0,0,0,0]]; this.objects.clear(); this.program.clear(); this.engine3d.captured.clear(); if(this.engine3d.backend) this.engine3d.backend.reset(); }
    get busy() { return this.engine3d.busy || this.flips.some(f=>!!f[3]); }
    reg(at) { return this.device.registers.get(at) || 0; }
    set(at, value) { this.device.registers.set(at, value >>> 0); }
    implemented(at)
    {
        return [0x400100, 0x400104, 0x400108, 0x40013C, 0x400300, 0x400304,
            0x400324, 0x400328, 0x40032C, 0x400330, 0x400700, 0x400704, 0x400708, 0x40071C, 0x400720].includes(at);
    }

    read(at)
    {
        if(at === 0x400700) return this.busy ? 1 : 0;
        if(at === 0x40071C) return 0;
        if(at === 0x400328) return this.program.get(this.reg(0x400324)) || 0;
        return null;
    }

    written(at, value)
    {
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
            this.program.set(this.reg(0x400324), this.reg(at));
            this.set(0x400324, this.reg(0x400324) + 1);
        }
        // The host saves/restores decoded contexts by channel. Keep uploaded
        // context microcode for readback, without executing foreign firmware.
        if(at === 0x400304 && value & 1) this.set(0x400300, this.reg(0x400300) & ~1);
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
        this.set(0x400704, channel << 24 | subc << 13 | method);
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
            object = this.object(channel, instance);
            accepted = method === 0x100 || method === 0x108 || method === 0x10C;
            if(method === 0x104)
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
        return [2, Array.from(this.objects.values(), o => [o.channel, o.instance, o.class_id, Array.from(o.methods), o.stream]),
            Array.from(this.program),this.flips.map(f=>f.slice())];
    }
    set_state(state)
    {
        this.reset();
        for(const [channel, instance, class_id, methods, stream] of state[1])
            this.objects.set(channel + ":" + instance, { channel, instance, class_id, methods: new Map(methods), stream });
        this.program = new Map(state[2]);
        if(state[0]>=2)this.flips=state[3].map(f=>f.slice());
    }
}
