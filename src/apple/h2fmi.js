// Three MMIO pages of each A4 flash controller: transfer FIFO, NAND
// command sequencer and ECC. Register status is write-one-to-clear.
import { NAND_DATA, NAND_PAGE } from "./nand.js";

const ERASED = new Uint8Array(NAND_PAGE).fill(255);

export class AppleH2FMI
{
    constructor(cpu, base, bus = 0, nand = null, signal = level => {}, dma = null)
    {
        this.base = base;
        this.dma = dma;
        this.nand = nand;
        this.bus = bus;
        this.signal = signal;
        this.epoch = 0;
        this.page = null;
        this.column = 0;
        this.fail = false;
        this.erased = true;
        this.requests = 0;
        if(dma)
        {
            dma.ports.set(base + 0x14, () => this.drain(1));
            dma.ports.set(base + 0x18, () => this.drain(2));
        }
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

    reset()
    {
        this.epoch++;
        this.regs.fill(0);
        this.id_offset = this.column = 0;
        this.page = null;
        this.requests = 0;
        this.erased = true;
        this.fail = false;
        this.update_irq();
    }

    update_irq()
    {
        this.signal(!!(this.regs[4] & this.read(0xC)));
    }

    load_page(run)
    {
        const address = this.regs[0x1018 >>> 2], row = (address >>> 16) + ((this.regs[0x101C >>> 2] & 255) << 16);
        const mask = this.regs[0x100C >>> 2], ce = 31 - Math.clz32(mask & -mask);
        const epoch = ++this.epoch;
        this.page = null;
        this.requests = 0;
        this.fail = false;
        this.column = address & 65535;
        const complete = (page, failed) => {
            if(this.epoch !== epoch) return;
            this.page = page;
            this.erased = !page || page.every(byte => byte === 255);
            this.fail = failed;
            this.regs[0x1044 >>> 2] |= run & 15;
            this.update_irq();
        };
        if(this.nand && this.chips.has(ce))
            this.nand.read(this.bus, ce, row, page => complete(page, false), () => complete(null, true));
        else complete(null, false);
    }

    drain(bit)
    {
        if(!(this.requests & bit)) return;
        const page = this.page || ERASED, meta = bit === 2;
        const source = meta ? page.subarray(NAND_DATA) : page.subarray(this.column, NAND_DATA);
        if(this.dma.receive(this.base + (meta ? 0x18 : 0x14), source)) this.requests &= ~bit;
    }

    data_word()
    {
        let value = 0;
        for(let b = 0; b < 4; b++) value |= (this.page?.[this.column + b] ?? 255) << (8 * b);
        this.column += 4;
        return value >>> 0;
    }

    read(offset)
    {
        if(offset === 0x200C) return this.fail ? 4 : this.erased ? 2 : 0;
        if(offset === 0xC) return this.regs[3] | (this.regs[0x1040 >>> 2] & this.regs[0x1044 >>> 2] ? 0x100 : 0);
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
        if((offset === 0x14 || offset === 0x1024) && [0x70, 0xF1, 0xF2].includes(command)) return 0xC0 | Number(this.fail);
        if(offset === 0x14 && (command === 0 || command === 0x3000)) return this.data_word();
        return this.regs[offset >>> 2] || 0;
    }

    write(offset, value)
    {
        const index = offset >>> 2;
        if(offset === 0xC || offset === 0x1044) { this.regs[index] &= ~value; this.update_irq(); return; }
        this.regs[index] = value;
        if(offset === 0x1010)
        {
            const command = this.regs[0x1014 >>> 2];
            if(command === 0x3000)
            {
                this.load_page(value);
                return;
            }
            if(value === 0x50 && [0x70, 0xF1, 0xF2].includes(command))
            {
                this.regs[0x1048 >>> 2] = 0xC0 | Number(this.fail);
                this.regs[0x1044 >>> 2] |= 0x20;
            }
            if([0, 0x70, 0xF1, 0xF2, 0x90, 0xFF].includes(command))
            {
                this.id_offset = command === 0x90 ? this.regs[0x1018 >>> 2] & 255 : 0;
                this.regs[0x1044 >>> 2] |= value & 15;
            }
        }
        if(offset === 4 && value === 3 && [0, 0x70, 0xF1, 0xF2, 0x90, 0x3000].includes(this.regs[0x1014 >>> 2]))
        {
            if(this.dma && [0, 0x3000].includes(this.regs[0x1014 >>> 2]))
            {
                this.requests = 3;
                this.drain(1);
                this.drain(2);
            }
            this.regs[3] |= 2;
        }
        this.update_irq();
    }

    get_state() { return [this.regs.slice(), this.id_offset, Array.from(this.chips), this.page?.slice() || null, this.column, this.fail, this.requests]; }
    set_state(state)
    {
        this.epoch++;
        this.regs.set(state[0]);
        this.id_offset = state[1];
        this.chips = new Map(state[2]);
        this.page = state[3] || null;
        this.erased = !this.page || this.page.every(byte => byte === 255);
        this.column = state[4] || 0;
        this.fail = !!state[5];
        this.requests = state[6] || 0;
        this.update_irq();
    }
}
