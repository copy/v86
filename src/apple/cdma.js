// S5L8930 channel DMA. Bank zero contains two 32-bit channel-enable masks.
// Channels 1..37 have configuration and descriptor registers on a 4 KiB
// stride. At S1 the driver resets and disables them during its probe.
export class AppleCDMA
{
    constructor(cpu)
    {
        this.enabled = new Uint32Array(2);
        this.channel = new Uint32Array(38 * 8);
        this.aes = new Uint32Array(0x9000 / 4);
        cpu.io.register_mmio(0x87800000, 0x9000, {
            name: "cdma-aes",
            read: offset => this.aes[offset >>> 2],
            write: (offset, width, value) => { this.aes[offset >>> 2] = Number(value); },
        });
        cpu.io.register_mmio(0x87000000, 0x26000, {
            name: "cdma",
            read: offset => this.read(offset),
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
    }

    read(offset)
    {
        if(offset === 0x10 || offset === 0x14) return this.enabled[(offset - 0x10) >>> 2];
        const n = offset >>> 12, reg = offset & 4095;
        return n && reg < 32 ? this.channel[n * 8 + (reg >>> 2)] : 0;
    }

    write(offset, value)
    {
        if(offset < 8) this.enabled[offset >>> 2] |= value;
        else if(offset < 16) this.enabled[(offset - 8) >>> 2] &= ~value;
        else
        {
            const n = offset >>> 12, reg = offset & 4095;
            if(n && reg === 0 && value === 2) this.channel.fill(0, n * 8, n * 8 + 8);
            else if(n && reg > 0 && reg < 32) this.channel[n * 8 + (reg >>> 2)] = value;
        }
    }

    reset() { this.enabled.fill(0); this.channel.fill(0); this.aes.fill(0); }
    get_state() { return [this.enabled.slice(), this.channel.slice(), this.aes.slice()]; }
    set_state(state) { this.enabled.set(state[0]); this.channel.set(state[1]); this.aes.set(state[2]); }
}
