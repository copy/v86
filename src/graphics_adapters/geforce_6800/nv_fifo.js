// NV40 PFIFO. Original implementation; encodings/layouts from envytools rnndb
// and Nouveau's MIT-licensed nvkm/engine/fifo/nv40.c and core/ramht.c.
const RAMFC = [[0x00, 0x3240], [0x04, 0x3244], [0x08, 0x3248], [0x0C, 0x322C],
    [0x10, 0x32A0], [0x14, 0x3228], [0x18, 0x3224], [0x1C, 0x3280], [0x20, 0x3254],
    [0x24, 0x3268], [0x28, 0x3264], [0x2C, 0x3260], [0x30, 0x326C], [0x34, 0x324C],
    [0x38, 0x32E0], [0x3C, 0x2044], [0x40, 0x32E4], [0x44, 0x32E8],
    [0x4C, 0x2088], [0x50, 0x3300], [0x54, 0x330C]];
const SPECIAL = [0, 8, 0x50, 0x60, 0x64, 0x68, 0x6C, 0x80];

export class NVFIFO
{
    constructor(device)
    {
        this.device = device;
        this.active = -1;
        this.channels = new Map();
        this.running = false;
    }

    reset()
    {
        this.active = -1;
        this.channels = new Map();
        this.running = false;
    }

    reg(at) { return this.device.registers.get(at) || 0; }
    set(at, value) { this.device.registers.set(at, value >>> 0); }
    implemented(offset)
    {
        return this.user(offset) !== null || offset >= 0x90000 && offset < 0x91000 ||
            [0x2210, 0x2220, 0x2400, 0x2500, 0x2504, 0x2508, 0x3200, 0x3204, 0x3210, 0x3214,
                0x3220, 0x3224, 0x3228, 0x322C, 0x3230, 0x3234, 0x3238, 0x323C, 0x3240, 0x3244,
                0x3248, 0x324C, 0x3250, 0x3254, 0x3258, 0x3264, 0x3268, 0x326C, 0x3270, 0x3280,
                0x32A0, 0x32A4, 0x32A8, 0x32AC, 0x32E0].includes(offset);
    }
    channel(id)
    {
        if(!this.channels.has(id)) this.channels.set(id, { bindings: new Uint32Array(8), dma: -1, offset: 0 });
        return this.channels.get(id);
    }
    ramfc(id) { return (this.reg(0x2220) & 0xFFF) * 65536 + id * 128; }
    word(at) { return this.device.dma.word(at); }
    store(at, value)
    {
        if(at < 0 || at + 4 > 1 << 20 || at & 3) throw new RangeError("NV RAMFC outside RAMIN");
        const base = this.device.vram_size - (1 << 20) + at;
        new DataView(this.device.vram().buffer, this.device.vram().byteOffset + base, 4).setUint32(0, value >>> 0, true);
    }

    user(offset)
    {
        if(offset >= 0xC00000 && offset < 0xC20000) return [(offset - 0xC00000) >>> 12, offset & 0xFFF];
        if(offset >= 0x800000 && offset < 0xA00000) return [(offset - 0x800000) >>> 16, offset & 0x1FFF];
        return null;
    }

    read(offset)
    {
        const user = this.user(offset);
        if(user)
        {
            const [id, at] = user;
            const field = at === 0x40 ? 0 : at === 0x44 ? 4 : at === 0x48 ? 8 : -1;
            if(field >= 0) return id === this.active ? this.reg(0x3240 + field) : this.word(this.ramfc(id) + field);
            if(at === 0x54) return id === this.active && this.reg(0x3228) & 0x20000 ? this.reg(0x324C) :
                id === this.active ? this.reg(0x3244) : this.word(this.ramfc(id) + 4);
            return 0;
        }
        if(offset === 0x3214 || offset === 0x2400)
        {
            const used = (this.reg(0x3210) - this.reg(0x3270)) & 0x7FF;
            return used === 0 ? 0x10 : used === 0x400 ? 0x100 : 0;
        }
        if(offset === 0x3220) return this.reg(offset) & ~0x110 | (this.reg(0x3244) === this.reg(0x3240) ? 0x100 : 0);
        if(offset >= 0x90000 && offset < 0x91000) return this.reg(0x90000 + (offset & 0x7FF));
        return null;
    }

    write(offset, value)
    {
        const user = this.user(offset);
        if(user)
        {
            const [id, at] = user;
            if(at === 0x40)
            {
                this.store(this.ramfc(id), value);
                if(id === this.active) this.set(0x3240, value);
                this.set(0x2508, this.reg(0x2508) | 1 << id);
                this.device.machine.wake();
                this.run();
            }
            return true;
        }
        if(offset >= 0x90000 && offset < 0x91000)
        {
            this.set(0x90000 + (offset & 0x7FF), value);
            return true;
        }
        return false;
    }

    select(id)
    {
        if(this.active === id) return;
        this.save_channel();
        const base = this.ramfc(id);
        for(const [at, reg] of RAMFC)
        {
            const value = this.word(base + at);
            if(reg === 0x3224)
            {
                this.set(reg, value & 0x0FFFFFFF);
                this.set(0x2058, this.reg(0x2058) & ~0x30000000 | value & 0x30000000);
            }
            else if(reg === 0x2044) this.set(reg, this.reg(reg) & ~0x1FFFF | value & 0x1FFFF);
            else this.set(reg, value);
        }
        this.active = id;
        this.channel(id);
        this.set(0x3204, id | 0x10000);
        this.set(0x3220, 1);
        this.device.dma.load_cache(this.reg(0x322C) * 16);
    }

    save_channel()
    {
        if(this.active < 0) return;
        const base = this.ramfc(this.active);
        for(const [at, reg] of RAMFC)
        {
            const value = reg === 0x3224 ? this.reg(reg) & 0x0FFFFFFF | this.reg(0x2058) & 0x30000000 :
                reg === 0x2044 ? this.reg(reg) & 0x1FFFF : this.reg(reg);
            this.store(base + at, value);
        }
        this.device.machine.mmio_ram_mark_dirty(this.device.vga.lfb_region);
    }

    hash(handle)
    {
        const bits = 9 + (this.reg(0x2210) >>> 16 & 3), size = 8 * 2 ** bits;
        const base = (this.reg(0x2210) & 0x1F0) << 8, mask = 2 ** bits - 1;
        let hash = 0, value = handle >>> 0;
        while(value) { hash ^= value & mask; value >>>= bits; }
        hash ^= this.active << (bits - 4);
        const start = (hash & mask) * 8;
        const count = this.reg(0x2210) & 0x4000000 ? size / 8 : 16 << (this.reg(0x2210) >>> 24 & 3);
        for(let i = 0; i < count; i++)
        {
            const at = base + ((start + i * 8) % size), context = this.word(at + 4);
            if(context && this.word(at) === (handle >>> 0) && (context >>> 23 & 31) === this.active)
                return { instance: (context & 0xFFFFF) * 16, engine: context >>> 20 & 7 };
        }
        return null;
    }

    cache_error(flags)
    {
        this.set(0x3250, this.reg(0x3250) | flags);
        this.set(0x2100, this.reg(0x2100) | 1);
        this.device.update_irq();
        return false;
    }

    method(subc, method, value)
    {
        const ch = this.channel(this.active);
        this.device.trace.record("method", subc * 0x2000 + method, 4, true, value, method < 0x100);
        if(method === 8 || method === 0x80) return true;
        if(method === 0x50) { this.set(0x3248, value); return true; }
        if(method === 0 || method === 0x60 || method >= 0x180 && method < 0x200)
        {
            const object = this.hash(value);
            if(!object) return this.cache_error(0x10);
            this.set(0x3258, object.instance / 16 | 0x1000000);
            if(method === 0x60) { ch.dma = object.instance; return true; }
            if(method === 0)
            {
                ch.bindings[subc] = object.instance;
                this.set(0x3280, this.reg(0x3280) & ~(15 << (subc * 4)) | object.engine << (subc * 4));
                return object.engine === 1 || this.cache_error(0x100);
            }
            value = object.instance / 16;
        }
        if(method === 0x64) { ch.offset = value; return true; }
        if(method === 0x68 || method === 0x6C)
        {
            if(ch.dma < 0) return this.cache_error(0x100000);
            const dma = this.device.dma.descriptor(ch.dma);
            if(method === 0x68)
            {
                this.set(0x3268, value);
                const bytes = this.device.dma.read(dma, ch.offset, 4);
                if(new DataView(bytes.buffer).getUint32(0, true) !== (value >>> 0))
                {
                    this.set(0x3250, this.reg(0x3250) | 0x10000);
                    this.set(0x3254, this.reg(0x3254) | 0x10);
                    return true; // accepted; suspend this channel before its next method
                }
                this.set(0x3250, this.reg(0x3250) & ~0x10000);
                this.set(0x3254, this.reg(0x3254) & ~0x10);
            }
            else
            {
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
                this.device.dma.write(dma, ch.offset, bytes);
            }
            return true;
        }
        // Engine zero objects (e.g. the driver's software DAC class) must trap
        // every method to the miniport, not be interpreted as PGRAPH instances.
        if((this.reg(0x3280) >>> (subc * 4) & 15) !== 1) return this.cache_error(0x100);
        return this.device.graph ? this.device.graph.method(this.active, subc, ch.bindings[subc], method, value) : this.cache_error(0x100);
    }

    drain()
    {
        if(!(this.reg(0x3250) & 1) || this.reg(0x2100) & 1) return false;
        while(this.reg(0x3270) !== this.reg(0x3210))
        {
            const get = this.reg(0x3270), at = 0x90000 + (get & 0x3FC) * 2, header = this.reg(at);
            if(!this.method(header >>> 13 & 7, header & 0x1FFC, this.reg(at + 4))) return false;
            this.set(0x3270, (get + 4) & 0x7FC);
            if(this.reg(0x3254) & 0x10) return false;
        }
        return true;
    }

    resume_acquire()
    {
        if(!(this.reg(0x3254) & 0x10)) return true;
        const ch = this.channel(this.active), dma = this.device.dma.descriptor(ch.dma);
        const bytes = this.device.dma.read(dma, ch.offset, 4);
        if(new DataView(bytes.buffer).getUint32(0, true) !== this.reg(0x3268)) return false;
        this.set(0x3250, this.reg(0x3250) & ~0x10000);
        this.set(0x3254, this.reg(0x3254) & ~0x10);
        return true;
    }

    fault(code)
    {
        this.set(0x3228, this.reg(0x3228) & 0x1FFFFFFF | code << 29);
        this.set(0x3220, this.reg(0x3220) | 0x1000);
        this.set(0x2100, this.reg(0x2100) | 0x1000);
        this.device.update_irq();
    }

    run(budget = 1024)
    {
        if(this.running || !(this.reg(0x200) & 0x100) || !(this.reg(0x3200) & 1)) return;
        this.running = true;
        try
        {
            for(let id = 0; id < 32 && budget > 0; id++)
            {
                if(!(this.reg(0x2508) & 1 << id) || !(this.reg(0x2504) & 1 << id)) continue;
                if(id !== this.active && (!(this.reg(0x2500) & 1) || this.reg(0x3210) !== this.reg(0x3270))) continue;
                this.select(id);
                if(!(this.reg(0x3220) & 1) || this.reg(0x3220) & 0x1000 || this.reg(0x3228) >>> 29) continue;
                if(!this.resume_acquire()) continue;
                const dma = this.device.dma.descriptor(this.reg(0x322C) * 16);
                this.drain();
                while(this.reg(0x3244) !== this.reg(0x3240) && budget-- > 0)
                {
                    if(((this.reg(0x3210) - this.reg(0x3270)) & 0x7FF) === 0x400) break;
                    const get = this.reg(0x3244);
                    if(get & 3) { this.fault(6); break; }
                    const bytes = this.device.dma.read(dma, get, 4);
                    const word = new DataView(bytes.buffer).getUint32(0, !(this.reg(0x3224) & 0x80000000));
                    this.set(0x3244, get + 4);
                    let state = this.reg(0x3228), count = state >>> 18 & 0x7FF;
                    if(count)
                    {
                        const method = state & 0x1FFC;
                        if(method < 0x100 && !SPECIAL.includes(method)) { this.fault(2); break; }
                        const put = this.reg(0x3210), at = 0x90000 + (put & 0x3FC) * 2;
                        this.set(at, state & 0xFFFF); this.set(at + 4, word);
                        this.set(0x3210, (put + 4) & 0x7FC);
                        count--;
                        state = state & 0x20000 | count << 18 | state & 0xE001 | (state & 1 ? method : method + 4 & 0x1FFC);
                        this.set(0x3228, state);
                        this.set(0x32A0, this.reg(0x32A0) + 1);
                        this.set(0x32AC, word);
                        if(!this.drain()) break;
                    }
                    else if((word & 3) === 1 || (word & 0xE0000003) === 0x20000000)
                    {
                        this.set(0x32A4, get);
                        this.set(0x3244, (word & 3) === 1 ? word & 0xFFFFFFFC : word & 0x1FFFFFFC);
                    }
                    else if((word & 3) === 2)
                    {
                        if(state & 0x20000) { this.fault(1); break; }
                        this.set(0x324C, get + 4); this.set(0x3244, word & 0xFFFFFFFC);
                        this.set(0x3228, state | 0x20000);
                    }
                    else if(word === 0x20000)
                    {
                        if(!(state & 0x20000)) { this.fault(3); break; }
                        this.set(0x3244, this.reg(0x324C)); this.set(0x3228, state & ~0x20000);
                    }
                    else if((word & 0xE0030003) === 0 || (word & 0xE0030003) === 0x40000000)
                    {
                        this.set(0x3228, state & 0x20000 | word & 0x1FFCE000 | word & 0x1FFC | word >>> 30 & 1);
                        this.set(0x32A0, 0); this.set(0x32A8, word);
                    }
                    else { this.fault(4); break; }
                }
                this.drain();
                this.save_channel();
                if(this.reg(0x3244) === this.reg(0x3240) && this.reg(0x3210) === this.reg(0x3270) && !(this.reg(0x3254) & 0x10))
                    this.set(0x2508, this.reg(0x2508) & ~(1 << id));
            }
        }
        catch(error)
        {
            if(!(error instanceof RangeError)) throw error;
            this.fault(6);
        }
        finally { this.running = false; }
    }

    get_state() { return [1, this.active, Array.from(this.channels, ([id, ch]) => [id, ch.bindings, ch.dma, ch.offset])]; }
    set_state(state)
    {
        this.reset(); this.active = state[1];
        for(const [id, bindings, dma, offset] of state[2]) this.channels.set(id, { bindings: new Uint32Array(bindings), dma, offset });
    }
}
