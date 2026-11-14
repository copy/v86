// CD3282 Mikey control port on the N90's first I2C bus. The board currently
// has no connected headset or remote; their sense and event bits stay clear.
export class AppleMikey
{
    constructor() { this.regs = new Uint8Array(16); }
    reset() { this.regs.fill(0); }

    read(reg)
    {
        const value = this.regs[reg] || 0;
        if(reg === 13 || reg === 14) this.regs[reg] = 0;
        return value;
    }

    write(reg, value)
    {
        if(reg === 1 && (value & 0x80)) this.reset();
        // Revision, accessory sense and event registers are hardware inputs.
        if(reg < 16 && ![7, 10, 12, 13, 14].includes(reg))
            this.regs[reg] = reg === 1 ? value & 0x7f : value;
    }

    get_state() { return [this.regs.slice()]; }
    set_state(state) { this.reset(); if(state) this.regs.set(state[0]); }
}

// CS42L61 codec register port. PCM transport is handled separately by I2S.
// The three identification bytes are hardware inputs, including revision 0.
export class AppleCS42L61
{
    constructor() { this.regs = new Uint8Array(128); this.reset(); }
    reset() { this.regs.fill(0); this.regs.set([0x42, 0xa6, 0x10], 1); }
    read(reg) { return this.regs[reg] || 0; }
    write(reg, value) { if(reg === 0 || reg > 3 && reg < 128) this.regs[reg] = value; }
    get_state() { return [this.regs.slice()]; }
    set_state(state) { this.reset(); if(state) this.regs.set(state[0]); }
}

// Three independent Samsung I2S v2 control banks. Bit 0 requests the serial
// clock; bit 1 acknowledges that it has stopped. PCM DMA follows the
// programmed bit clock and advances only whole stereo S16 frames.
export class AppleI2S
{
    constructor(cpu, index, bus = null, dma = null)
    {
        this.cpu = cpu;
        this.index = index;
        this.bus = bus;
        this.dma = dma;
        this.port = 0x84500410 + index * 0x1000;
        this.last = cpu.clock?.now() || 0;
        this.rate = 0;
        this.frames = 0;
        this.regs = new Uint32Array(0xc00 / 4);
        dma?.ports.set(this.port, () => { this.last = this.cpu.clock.now(); });
        cpu.io.register_mmio(0x84500000 + index * 0x1000, 0x1000, {
            name: "i2s",
            read: offset => this.read(offset - 0x400),
            write: (offset, width, value) => this.write(offset - 0x400, Number(value)),
        });
    }

    read(offset)
    {
        if(offset === 0) return this.regs[0] | (this.regs[0] & 1 ? 0 : 2);
        return this.regs[offset >>> 2] || 0;
    }
    write(offset, value)
    {
        this.poll();
        if(offset >= 0 && offset < 0xc00) this.regs[offset >>> 2] = offset === 0 ? value & ~2 : value;
    }

    poll()
    {
        if(!this.dma) return;
        const now = this.cpu.clock.now(), bclk = this.cpu.devices?.apple_timer?.regs[(0x104 + this.index * 0x10) >>> 2] || 0;
        const rate = bclk / 64;
        if(!(this.regs[0] & 1) || !Number.isInteger(rate) || rate < 8000 || rate > 192000)
        {
            this.last = now;return;
        }
        for(let n = 1; n < 38; n++)
        {
            const i = n * 8;
            if(!(this.dma.channel[i] & 1) || this.dma.channel[i + 2] !== this.port) continue;
            const frames = Math.min(8192, Math.floor(Math.max(0, now - this.last) * rate / 1000));
            if(!frames) return;
            const bytes = new Uint8Array(Math.min(frames * 4, this.dma.channel[i + 3]));
            const before = this.dma.channel[i + 3];
            this.dma.transfer(this.port, bytes, false);
            const used = Math.min(bytes.length, before - this.dma.channel[i + 3]) & ~3;
            if(!used) { this.last = now;return; }
            this.last += used / 4 * 1000 / rate;
            this.frames += used / 4;
            if(this.bus && this.index === 0)
            {
                if(this.rate !== rate)
                {
                    this.rate = rate;
                    this.bus.send("dac-tell-sampling-rate", rate);
                    this.bus.send("dac-enable");
                }
                const left = new Float32Array(used / 4), right = new Float32Array(used / 4), v = new DataView(bytes.buffer);
                for(let p = 0; p < left.length; p++)
                {
                    left[p] = v.getInt16(p * 4, true) / 32768;
                    right[p] = v.getInt16(p * 4 + 2, true) / 32768;
                }
                this.bus.send("dac-send-data", [left, right]);
            }
            return;
        }
        this.last = now;
    }

    reset() { this.regs.fill(0);this.last = this.cpu.clock?.now() || 0;this.frames = 0;this.rate = 0; }
    get_state() { return [this.regs.slice(), this.last, this.frames, this.rate]; }
    set_state(state) { this.regs.set(state[0]);this.last = state[1] ?? (this.cpu.clock?.now() || 0);this.frames = state[2] || 0;this.rate = state[3] || 0; }
}
