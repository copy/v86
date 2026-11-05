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
