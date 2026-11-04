// N90 /arm-io/vic: four PL192 banks on a 64 KiB stride.
export class AppleVIC
{
    constructor(cpu, base = 0xBF200000, signal = (irq, fiq) => cpu.wm.exports["a32_set_interrupt_lines"](irq, fiq))
    {
        this.signal = signal;
        this.regs = new Uint32Array(4 * 256);
        this.lines = new Uint32Array(4);
        this.active = [[], [], [], []];
        this.chain = [];
        this.reset();
        cpu.io.register_mmio(base, 0x40000, {
            name: "vic",
            read: address => this.read(address >>> 16, address & 65535),
            write: (address, width, value) => this.write(address >>> 16, address & 65535, Number(value)),
        });
    }

    reset()
    {
        this.regs.fill(0);
        this.lines.fill(0);
        this.chain.length = 0;
        for(let b = 0; b < 4; b++)
        {
            this.regs[b * 256 + 9] = 65535;
            this.regs.fill(15, b * 256 + 128, b * 256 + 160);
            this.active[b].length = 0;
        }
        this.update();
    }

    set_line(irq, level)
    {
        const mask = 1 << (irq & 31), b = irq >>> 5;
        this.lines[b] = level ? this.lines[b] | mask : this.lines[b] & ~mask;
        this.update();
    }

    status(b, fiq)
    {
        const i = b * 256;
        return (this.lines[b] | this.regs[i + 6]) & this.regs[i + 4] & (fiq ? this.regs[i + 3] : ~this.regs[i + 3]);
    }

    next(b)
    {
        const i = b * 256, stack = this.active[b];
        let threshold = stack.length ? stack[stack.length - 1] : 16, best = -1;
        for(let bits = this.status(b, false); bits; bits &= bits - 1)
        {
            const line = 31 - Math.clz32(bits & -bits), priority = this.regs[i + 128 + line];
            if(priority < threshold && (this.regs[i + 9] & 1 << priority))
            {
                best = line;
                threshold = priority;
            }
        }
        return best;
    }

    // N90 wires VIC1..3 through VIC0. XNU always reads and completes
    // the vector at the first bank, even for an IRQ numbered over 31.
    pending_bank()
    {
        const last = this.chain[this.chain.length - 1];
        let best = -1, priority = last ? last.priority : 16;
        for(let b = 0; b < 4; b++)
        {
            const line = this.next(b);
            if(line < 0) continue;
            const p = this.regs[b * 256 + 128 + line];
            if(p < priority) { best = b; priority = p; }
        }
        return best;
    }

    update()
    {
        const irq = this.pending_bank() >= 0;
        let fiq = false;
        for(let b = 0; b < 4; b++)
        {
            fiq = fiq || !!this.status(b, true);
        }
        this.signal(irq, fiq);
    }

    read(b, offset)
    {
        const i = b * 256;
        switch(offset)
        {
            case 0: return this.status(b, false);
            case 4: return this.status(b, true);
            case 8: return this.lines[b] | this.regs[i + 6];
            case 0xF00: {
                const bank = b === 0 ? this.pending_bank() : b;
                if(bank < 0) return 0;
                const line = this.next(bank);
                if(line < 0) return 0;
                const priority = this.regs[bank * 256 + 128 + line];
                this.active[bank].push(priority);
                if(!b) this.chain.push({ bank, priority, local_done: false });
                this.update();
                return this.regs[bank * 256 + 64 + line];
            }
        }
        if(offset >= 0xFE0 && offset <= 0xFFC) return [0x92, 0x11, 4, 0, 0x0D, 0xF0, 5, 0xB1][(offset - 0xFE0) >>> 2];
        return offset < 0x400 ? this.regs[i + (offset >>> 2)] : 0;
    }

    write(b, offset, v)
    {
        const i = b * 256;
        switch(offset)
        {
            case 0x10: this.regs[i + 4] |= v; break;
            case 0x14: this.regs[i + 4] &= ~v; break;
            case 0x18: this.regs[i + 6] |= v; break;
            case 0x1C: this.regs[i + 6] &= ~v; break;
            case 0xF00: {
                const top = this.chain[this.chain.length - 1];
                if(b === 0 && top)
                {
                    this.chain.pop();
                    if(!top.local_done) this.active[top.bank].pop();
                }
                else
                {
                    this.active[b].pop();
                    if(top && top.bank === b) top.local_done = true;
                }
                break;
            }
            default:
                if(offset === 12 || offset === 0x24 || offset >= 0x100 && offset < 0x180) this.regs[i + (offset >>> 2)] = v;
                if(offset >= 0x200 && offset < 0x280) this.regs[i + (offset >>> 2)] = v & 15;
        }
        this.update();
    }

    get_state() { return [this.regs.slice(), this.lines.slice(), this.active.map(s => s.slice()), this.chain.map(v => [v.bank, v.priority, v.local_done])]; }
    set_state(state)
    {
        this.regs.set(state[0]);
        this.lines.set(state[1]);
        this.active = state[2].map(s => Array.from(s));
        this.chain = (state[3] || []).map(v => ({ bank: v[0], priority: v[1], local_done: !!v[2] }));
        this.update();
    }
}
