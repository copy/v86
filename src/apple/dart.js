// A4 DART: four streams, each with 64 page tables covering 4 MiB apiece.
// Table entries contain 4 KiB physical pages and a validity bit.
export class AppleDART
{
    constructor(cpu, name, base)
    {
        this.cpu = cpu;
        this.regs = new Uint32Array(0x2000 / 4);
        this.tables = new Uint32Array(4 * 64);
        cpu.io.register_mmio(base, 0x2000, {
            name,
            read: offset => this.regs[offset >>> 2],
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
    }

    write(offset, value)
    {
        this.regs[offset >>> 2] = value;
        if(offset === 0)
        {
            const index = (value >>> 8 & 3) * 64 + (value >>> 22 & 63);
            if((value & 7) === 5) this.tables[index] = this.regs[2];
            else if((value & 7) === 4) this.regs[2] = this.tables[index];
            this.regs[0] &= ~8; // command execution is synchronous
        }
    }

    translate(address, stream)
    {
        if(address < 0 || address >= 0x10000000 || stream < 0 || stream >= 4) return -1;
        const table = this.tables[stream * 64 + (address >>> 22)];
        if(!(table & 1)) return -1;
        const at = this.cpu.ram_offset((table & 0xFFFFF000) + (address >>> 12 & 1023) * 4, 4);
        if(at < 0) return -1;
        const entry = new DataView(this.cpu.mem8.buffer, this.cpu.mem8.byteOffset + at, 4).getUint32(0, true);
        return entry & 1 ? ((entry & 0xFFFFF000) + (address & 4095)) >>> 0 : -1;
    }

    reset() { this.regs.fill(0); this.tables.fill(0); }
    get_state() { return [this.regs.slice(), this.tables.slice()]; }
    set_state(state)
    {
        this.regs.set(state[0]); this.tables.fill(0);
        if(state[1]) this.tables.set(state[1]);
    }
}
