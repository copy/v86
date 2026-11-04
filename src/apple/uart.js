// N90AP /arm-io/uart0 ("uart-1,samsung", IRQ 22), the boot console.
// UTXH completes synchronously on the serial bus. UTRSTAT and UFSTAT
// describe the same RX queue in polling mode and FIFO mode.
export class AppleUART
{
    constructor(cpu, bus)
    {
        this.bus = bus;
        this.regs = new Uint32Array(16);
        this.rx = [];
        this.reset();
        cpu.io.register_mmio(0x82500000, 0x1000, {
            name: "uart0",
            read: offset => this.read(offset),
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
        bus.register("serial0-input", byte => { if(this.rx.length < 16) this.rx.push(byte & 255); }, this);
    }

    reset()
    {
        this.regs.fill(0);
        this.rx.length = 0;
    }

    read(offset)
    {
        switch(offset)
        {
            case 0x10: return 6 | Number(this.rx.length > 0);
            case 0x18: return this.rx.length === 16 ? 1 << 8 : this.rx.length;
            case 0x24: return this.rx.shift() || 0;
            default: return this.regs[offset >>> 2] || 0;
        }
    }

    write(offset, value)
    {
        if(offset === 0x20) this.bus.send("serial0-output-byte", value & 255);
        else if(offset === 8)
        {
            if(value & 2) this.rx.length = 0;
            this.regs[2] = value & ~6;
        }
        else if(offset < 0x10 || offset === 0x28 || offset === 0x2C) this.regs[offset >>> 2] = value;
    }

    get_state() { return [this.regs.slice(), this.rx.slice()]; }
    set_state(state) { this.regs.set(state[0]); this.rx = Array.from(state[1]); }
}
