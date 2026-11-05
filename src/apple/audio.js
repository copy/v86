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
// clock; bit 1 acknowledges that it has stopped. PCM DMA is not yet attached.
export class AppleI2S
{
    constructor(cpu, index)
    {
        this.regs = new Uint32Array(0xc00 / 4);
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
        if(offset >= 0 && offset < 0xc00) this.regs[offset >>> 2] = offset === 0 ? value & ~2 : value;
    }
    reset() { this.regs.fill(0); }
    get_state() { return [this.regs.slice()]; }
    set_state(state) { this.regs.set(state[0]); }
}
