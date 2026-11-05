// Samsung SPI v1: independent 16-byte transmit/receive FIFOs. N90 uses
// SPI1 for touch; SPI2 is the cellular interface and is not instantiated.
export class AppleSPI
{
    constructor(cpu, index, signal, exchange = (byte, first, length) => 0xff, dma = null)
    {
        this.signal = signal;
        this.exchange = exchange;
        this.dma = dma;
        this.dma_port = 0x82000010 + index * 0x100000;
        this.dma_pending = null;
        this.dma_done = false;
        this.pumping = false;
        this.transferred = 0;
        this.regs = new Uint32Array(0x1000 / 4);
        this.tx = [];
        this.rx = [];
        dma?.ports.set(this.dma_port, () => this.shift());
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
        {
            // The N1 firmware upload uses transmit DMA with no receive
            // clocks requested. Receive DMA is a separate, unmodelled mode.
            if((this.regs[1] & 0x40) && this.dma && !this.regs[0x34 >>> 2]) this.shift_dma();
            else while(this.tx.length && this.rx.length < 16)
                this.rx.push(this.exchange(this.tx.shift(), this.transferred++ === 0, this.regs[0x4C >>> 2]) & 255);
        }
        this.update_irq();
    }

    shift_dma()
    {
        if(this.pumping || this.dma_done) return;
        const length = this.regs[0x4C >>> 2];
        if(!length || length > 16 * 1024 * 1024) return;
        this.pumping = true;
        try
        {
            const pending = this.dma_pending || (this.dma_pending = [new Uint8Array(length), 0]);
            const bytes = pending[0].subarray(pending[1]);
            const left = this.dma.transfer(this.dma_port, bytes, false);
            if(left === null) return;
            if(left >= 0)
            {
                const used = bytes.length - left;
                for(let i = 0; i < used; i++) this.exchange(bytes[i], this.transferred++ === 0, length);
                pending[1] += used;
            }
            if(left <= 0) { this.dma_pending = null; this.dma_done = true; }
        }
        finally { this.pumping = false; }
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
            if(!(value & 1) || value & 12) { this.dma_pending = null; this.dma_done = false; this.transferred = 0; }
            this.regs[0] = value & ~12;
        }
        else if(offset === 0x4C)
        {
            this.regs[offset >>> 2] = value;
            this.dma_pending = null;
            this.dma_done = false;
            this.transferred = 0;
        }
        else if(offset === 4)
        {
            if((value & 0x60) && !(this.regs[1] & 0x60)) this.transferred = 0;
            this.regs[1] = value;
        }
        else this.regs[offset >>> 2] = value;
        this.shift();
    }

    reset()
    {
        this.regs.fill(0); this.tx.length = this.rx.length = 0;
        this.dma_pending = null; this.dma_done = false; this.pumping = false; this.transferred = 0; this.update_irq();
    }
    get_state()
    {
        return [this.regs.slice(), this.tx.slice(), this.rx.slice(),
            this.dma_pending ? [this.dma_pending[0].slice(), this.dma_pending[1]] : null, this.dma_done, this.transferred];
    }
    set_state(state)
    {
        this.regs.set(state[0]); this.tx = Array.from(state[1]); this.rx = Array.from(state[2]);
        this.dma_pending = state[3] ? [state[3][0].slice(), state[3][1]] : null;
        this.dma_done = !!state[4]; this.pumping = false; this.update_irq();
        this.transferred = state[5] || 0;
    }
}
