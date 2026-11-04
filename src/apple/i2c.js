// A4 I2C controllers. The command couples a register-address phase to
// a FIFO transfer. The status is latched until the guest acknowledges it.
export class AppleI2C
{
    constructor(cpu, base, irq, vic, pmu, backlight = null)
    {
        this.backlight = backlight;
        this.irq = irq;
        this.vic = vic;
        this.pmu = pmu ? new Uint8Array(256) : null;
        this.regs = new Uint32Array(10);
        this.fifo = [];
        this.reset();
        cpu.io.register_mmio(base, 0x1000, {
            name: "i2c",
            read: offset => offset === 0x20 ? this.fifo.shift() || 0 : this.regs[offset >>> 2] || 0,
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
    }

    reset()
    {
        this.regs.fill(0);
        this.fifo = [];
        if(this.pmu)
        {
            this.pmu.fill(0);
            this.pmu[0x66] = 255;
            this.pmu[0x67] = 7;
            this.pmu[0x68] = 0x15;
            this.update_backlight();
            this.pmu[7] = 8; // USB supply present
        }
        this.vic.set_line(this.irq, false);
    }

    update_backlight()
    {
        if(this.backlight) this.backlight(this.pmu[0x68] & 1 ? (this.pmu[0x66] << 3) | (this.pmu[0x67] & 7) : 0);
    }

    write(offset, value)
    {
        if(offset === 0x20)
        {
            if(this.fifo.length < 256) this.fifo.push(value & 255);
            return;
        }
        if(offset === 0x0C) this.regs[3] &= ~value;
        else if(offset < 40) this.regs[offset >>> 2] = value;
        if(offset === 0x24 && (value & 4))
        {
            const count = this.regs[6];
            if(this.pmu && this.regs[0] === 0x74 && count <= 256)
            {
                const subaddress = this.regs[4];
                if(value & 1)
                {
                    for(let i = 0; i < Math.min(count, this.fifo.length); i++) this.pmu[subaddress + i & 255] = this.fifo[i];
                    this.update_backlight();
                    this.fifo = [];
                }
                else this.fifo = Array.from({ length: count }, (_, i) => this.pmu[subaddress + i & 255]);
                this.regs[3] |= 0x10;
            }
            else
            {
                this.fifo = [];
                this.regs[3] |= 0x20;
            }
        }
        this.vic.set_line(this.irq, !!(this.regs[2] & this.regs[3]));
    }

    get_state() { return [this.regs.slice(), this.fifo.slice(), this.pmu?.slice() || null]; }
    set_state(state)
    {
        this.regs.set(state[0]);
        this.fifo = Array.from(state[1]);
        if(this.pmu) { this.pmu.set(state[2]); this.update_backlight(); }
        this.vic.set_line(this.irq, !!(this.regs[2] & this.regs[3]));
    }
}
