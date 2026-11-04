// Three MMIO pages of each A4 flash controller: transfer FIFO, NAND
// command sequencer and ECC. Register status is write-one-to-clear.
export class AppleH2FMI
{
    constructor(cpu, base)
    {
        this.regs = new Uint32Array(3 * 1024);
        this.id_offset = 0;
        this.chips = new Map();
        for(let bank = 0; bank < 3; bank++)
        {
            cpu.io.register_mmio(base + bank * 0x40000, 4096, {
                name: "h2fmi",
                read: offset => this.read(bank * 4096 + offset),
                write: (offset, width, value) => this.write(bank * 4096 + offset, Number(value)),
            });
        }
    }

    configure(ids, bus)
    {
        this.chips.clear();
        if(!ids || ids.length !== 256) return;
        for(let ce = 0; ce < 16; ce++)
        {
            const at = (bus * 16 + ce) * 8, id = ids.slice(at, at + 8);
            if(id[0] && id[0] !== 255) this.chips.set(ce, id);
        }
    }

    reset() { this.regs.fill(0); this.id_offset = 0; }

    read(offset)
    {
        if(offset === 0x14 && this.regs[0x1014 >>> 2] === 0x90)
        {
            const mask = this.regs[0x100C >>> 2];
            const chip = this.chips.get(31 - Math.clz32(mask & -mask));
            let word = 0;
            for(let byte = 0; byte < 4; byte++)
            {
                word |= (chip?.[this.id_offset] ?? 255) << (byte * 8);
                this.id_offset++;
            }
            return word >>> 0;
        }
        const command = this.regs[0x1014 >>> 2];
        if((offset === 0x14 || offset === 0x1024) && [0x70, 0xF1, 0xF2].includes(command)) return 0xC0;
        if(offset === 0x14 && command === 0x3000) return 0xFFFFFFFF;
        return this.regs[offset >>> 2] || 0;
    }

    write(offset, value)
    {
        const index = offset >>> 2;
        if(offset === 0xC || offset === 0x1044) { this.regs[index] &= ~value; return; }
        this.regs[index] = value;
        if(offset === 0x1010)
        {
            const command = this.regs[0x1014 >>> 2];
            if([0x70, 0xF1, 0xF2, 0x90, 0xFF, 0x3000].includes(command))
            {
                this.id_offset = command === 0x90 ? this.regs[0x1018 >>> 2] & 255 : 0;
                this.regs[0x1044 >>> 2] |= value & 15;
            }
        }
        if(offset === 4 && value === 3 && [0x70, 0xF1, 0xF2, 0x90, 0x3000].includes(this.regs[0x1014 >>> 2]))
            this.regs[3] |= 2;
    }

    get_state() { return [this.regs.slice(), this.id_offset, Array.from(this.chips)]; }
    set_state(state) { this.regs.set(state[0]); this.id_offset = state[1]; this.chips = new Map(state[2]); }
}
