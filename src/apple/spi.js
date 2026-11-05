// Samsung SPI v1: independent 16-byte transmit/receive FIFOs. N90 uses
// SPI1 for touch; SPI2 is the cellular interface and is not instantiated.
export class AppleSPI
{
    constructor(cpu, index, signal, exchange = byte => 0xff)
    {
        this.signal = signal;
        this.exchange = exchange;
        this.regs = new Uint32Array(0x1000 / 4);
        this.tx = [];
        this.rx = [];
        cpu.io.register_mmio(0x82000000 + index * 0x100000, 0x1000, {
            name: "spi",
            read: offset => this.read(offset),
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
    }

    update_irq()
    {
        this.signal(!!(this.regs[0] & 1) && !!this.rx.length && !!(this.regs[1] & 0x180));
    }

    shift()
    {
        if((this.regs[0] & 1) && (this.regs[1] & 0x60))
            while(this.tx.length && this.rx.length < 16)
                this.rx.push(this.exchange(this.tx.shift()) & 255);
        this.update_irq();
    }

    read(offset)
    {
        if(offset === 8) return (this.regs[2] & 0x40000f) | (this.tx.length << 6) | (this.rx.length << 11);
        if(offset === 0x20)
        {
            const value = this.rx.length ? this.rx.shift() : 0xff;
            this.shift();
            return value;
        }
        return this.regs[offset >>> 2] || 0;
    }

    write(offset, value)
    {
        if(offset === 8) this.regs[2] &= ~(value & 0x40000f);
        else if(offset === 0x10)
        {
            if(this.tx.length < 16) this.tx.push(value & 255);
        }
        else if(offset === 0)
        {
            if(value & 4) this.tx.length = 0;
            if(value & 8) this.rx.length = 0;
            this.regs[0] = value & ~12;
        }
        else this.regs[offset >>> 2] = value;
        this.shift();
    }

    reset() { this.regs.fill(0); this.tx.length = this.rx.length = 0; this.update_irq(); }
    get_state() { return [this.regs.slice(), this.tx.slice(), this.rx.slice()]; }
    set_state(state) { this.regs.set(state[0]); this.tx = Array.from(state[1]); this.rx = Array.from(state[2]); this.update_irq(); }
}
