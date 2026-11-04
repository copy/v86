// S5L8930 PMGR, including the 24 MHz system counter at +0x2000 and
// the CPU0 decrementer at +0x2008. Its interrupt is line 6 of VIC0.
export class AppleTimer
{
    constructor(cpu, vic)
    {
        this.clock = cpu.clock;
        this.vic = vic;
        this.regs = new Uint32Array(0x6000 / 4);
        this.deadline = -1;
        this.reset();
        cpu.io.register_mmio(0xBF100000, 0x6000, {
            name: "pmgr",
            read: offset => this.read(offset),
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
    }

    ticks() { return Math.floor(this.clock.now() * 24000); }
    reset()
    {
        this.regs.fill(0);
        this.deadline = -1;
        this.vic.set_line(6, false);
    }

    read(offset)
    {
        if(offset === 0x2000) return this.ticks() >>> 0;
        if(offset === 0x2004) return Math.floor(this.ticks() / 0x100000000);
        return this.regs[offset >>> 2];
    }

    write(offset, value)
    {
        // Clock gates expose the requested mode in bits 3:0 and the
        // acknowledged mode in 7:4. XNU polls until the nibbles agree.
        if(offset >= 0x1010 && offset < 0x1210) value = value & ~0xF0 | (value & 15) << 4;
        this.regs[offset >>> 2] = value;
        if(offset === 0x2008 && (this.regs[0x2010 >>> 2] & 1))
        {
            this.vic.set_line(6, false);
            this.deadline = this.ticks() + (value >>> 0);
        }
        if(offset === 0x2010)
        {
            this.vic.set_line(6, false);
            this.deadline = value & 1 ? this.ticks() + this.regs[0x2008 >>> 2] : -1;
        }
    }

    timer()
    {
        if(this.deadline < 0) return 100;
        const left = this.deadline - this.ticks();
        if(left > 0) return left / 24000;
        this.deadline = -1;
        this.vic.set_line(6, true);
        return 0;
    }

    get_state() { return [this.regs.slice(), this.deadline]; }
    set_state(state) { this.regs.set(state[0]); this.deadline = state[1]; }
}
