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
        this.page = null;
        this.column = 0;
        this.program = null;
        this.program_address = null;
        this.pio_left = 0;
        this.fail = false;
        this.erased = true;
        this.fifo_offset = new Uint32Array(2);
        this.requests = 0;
        if(dma)
        {
            dma.ports.set(base + 0x14, () => this.drain(1));
            dma.ports.set(base + 0x18, () => this.drain(2));
        }
        this.regs = new Uint32Array(3 * 1024);
        this.id_offset = 0;
        this.chips = new Map();
        this.cache = new Map();
        this.pending = new Map();
        this.failed_chips = new Set();
        this.page_chip = -1;
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
        this.cache.clear();
        this.pending.clear();
        this.failed_chips.clear();
        if(!ids || ids.length !== 256) return;
        for(let ce = 0; ce < 16; ce++)
        {
            const at = (bus * 16 + ce) * 8, id = ids.slice(at, at + 8);
            if(id[0] && id[0] !== 255) this.chips.set(ce, id);
        }
    }

    reset()
    {
        this.regs.fill(0);
        this.cache.clear();
        this.pending.clear();
        this.failed_chips.clear();
        this.page_chip = -1;
        this.id_offset = this.column = 0;
        this.page = null;
        this.requests = 0;
        this.program = null;
        this.program_address = null;
        this.pio_left = 0;
        this.erased = true;
        this.fail = false;
        this.update_irq();
    }

    update_irq()
    {
        this.signal(!!(this.regs[4] & this.read(0xC)));
    }

    chip()
    {
        const mask = this.regs[0x100C >>> 2];
        return 31 - Math.clz32(mask & -mask);
    }

    row()
    {
        return (this.regs[0x1018 >>> 2] >>> 16) + ((this.regs[0x101C >>> 2] & 255) << 16);
    }

    begin_operation(ce)
    {
        const token = {};
        this.pending.set(ce, token);
        this.failed_chips.delete(ce);
        return token;
    }

    complete_operation(ce, token, failed)
    {
        if(this.pending.get(ce) !== token) return false;
        this.pending.delete(ce);
        if(failed) this.failed_chips.add(ce);
        return true;
    }

    nand_status()
    {
        const ce = this.chip();
        return 0x80 | (this.pending.has(ce) ? 0 : 0x40) | Number(this.failed_chips.has(ce));
    }

    commit(run, erase)
    {
        const ce = this.chip(), token = this.begin_operation(ce);
        const finish = failed => {
            if(!this.complete_operation(ce, token, failed)) return;
            this.fail = failed;
            this.regs[0x1044 >>> 2] |= run & 15;
            this.update_irq();
        };
        const page = this.program, address = this.program_address, pioComplete = !this.pio_left;
        this.pio_left = 0;
        this.program = this.program_address = null;
        if(!this.nand || !this.chips.has(ce)) finish(true);
        else if(erase)
            this.nand.erase(this.bus, ce, this.regs[0x1018 >>> 2] & 0xFFFFFF, () => finish(false), () => finish(true));
        else if(page && address && ce === address[0] && pioComplete && !this.requests && !this.fail)
            this.nand.program(this.bus, ce, address[1], page, () => finish(false), () => finish(true));
        else finish(true);
    }

    load_page(run)
    {
        const address = this.regs[0x1018 >>> 2], row = this.row(), ce = this.chip();
        const token = this.begin_operation(ce);
        this.page = this.program = this.program_address = null;
        this.pio_left = 0;
        this.requests = 0;
        this.fail = false;
        this.column = address & 65535;
        const complete = (page, failed) => {
            if(!this.complete_operation(ce, token, failed)) return;
            const entry = [page, address & 65535, !page || page.every(byte => byte === 255), failed];
            this.cache.set(ce, entry);
            this.page_chip = ce;
            [this.page, this.column, this.erased, this.fail] = entry;
            this.regs[0x1044 >>> 2] |= run & 15;
            this.update_irq();
        };
        if(this.nand && this.chips.has(ce))
            this.nand.read(this.bus, ce, row, page => complete(page, false), () => complete(null, true));
        else complete(null, false);
    }

    // Each chip has its own read register. Scattered reads issue READ on
    // another chip before switching the bus back to drain the first chip.
    select_page()
    {
        const entry = this.cache.get(this.chip());
        if(entry)
        {
            this.page_chip = this.chip();
            [this.page, this.column, this.erased, this.fail] = entry;
        }

    }

    drain(bit)
    {
        if(!(this.requests & bit)) return;
        const page = this.program || this.page || ERASED, meta = bit === 2;
        const source = meta ? page.subarray(NAND_DATA, NAND_DATA + 12) : page.subarray(this.column, NAND_DATA);
        const fifo = meta ? 1 : 0, remaining = source.subarray(this.fifo_offset[fifo]);
        const result = this.dma.transfer(this.base + (meta ? 0x18 : 0x14), remaining, !this.program);
        if(result !== null)
        {
            if(result > 0)
            {
                this.fifo_offset[fifo] += remaining.length - result;
                return;
            }
            if(result < 0) this.fail = true;
            this.requests &= ~bit;
            if(!this.requests && (this.program || (this.regs[0] & 1)))
            {
                this.regs[3] |= 2;
                this.update_irq();
            }
        }
    }

    data_word()
    {
        if(this.page_chip !== this.chip()) this.select_page();
        let value = 0;
        for(let b = 0; b < 4; b++) value |= (this.page?.[this.column + b] ?? 255) << (8 * b);
        this.column += 4;
        return value >>> 0;
    }

    read(offset)
    {
        if(offset === 0x1C && this.pio_left) return 0x18;
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
        if((offset === 0x14 || offset === 0x1024) && [0x70, 0xF1, 0xF2].includes(command)) return this.nand_status();
        if(offset === 0x14 && (command === 0 || command === 0x3000)) return this.data_word();
        return this.regs[offset >>> 2] || 0;
    }

    write(offset, value)
    {
        const index = offset >>> 2;
        if(offset === 0x14 && this.program && this.pio_left)
        {
            for(let b = 0; b < 4; b++) this.program[this.column++] = value >>> (8 * b);
            this.pio_left -= 4;
            if(!this.pio_left)
            {
                this.regs[3] |= 2;
                this.update_irq();
            }
            return;
        }
        if(offset === 0xC || offset === 0x1044) { this.regs[index] &= ~value; this.update_irq(); return; }
        this.regs[index] = value;

        // The IOP flushes both FIFOs between a boot-page read and a page
        // program. Unserved read requests must not drain the new DMA list.
        if(offset === 4 && value === 6)
        {
            this.requests = 0;
            this.pio_left = 0;
        }
        if(offset === 0x1010)
        {
            const command = this.regs[0x1014 >>> 2];
            if(command === 0x80)
            {
                this.pending.delete(this.chip());
                this.failed_chips.delete(this.chip());
                this.program = ERASED.slice();
                this.pio_left = 0;
                this.program_address = [this.chip(), this.row()];
                this.column = this.regs[0x1018 >>> 2] & 65535;
                this.requests = 0;
                this.fail = false;
                this.regs[0x1044 >>> 2] |= value & 15;
            }
            if(value && (command === 0xD060 || command === 0x1000))
            {
                this.commit(value, command === 0xD060);
                return;
            }
            if(command === 0x3000)
            {
                this.load_page(value);
                return;
            }
            if(value === 0x50 && [0x70, 0xF1, 0xF2].includes(command))
            {
                this.regs[0x1048 >>> 2] = this.nand_status();
                this.regs[0x1044 >>> 2] |= 0x20;
            }
            if([0, 0x70, 0xF1, 0xF2, 0x90, 0xFF].includes(command))
            {
                this.id_offset = command === 0x90 ? this.regs[0x1018 >>> 2] & 255 : 0;
                this.regs[0x1044 >>> 2] |= value & 15;
            }
        }
        // The boot-page writer feeds three 512-byte sectors through PIO.
        // Its CFG clears the DMA enable bit before arming each sector.
        if(offset === 4 && value === 5 && this.program && !(this.regs[0] & 1))
            this.pio_left = Math.min(512, Math.max(0, NAND_DATA - this.column));
        else if(offset === 4 && value === 5 && this.program && this.dma)
        {
            this.fifo_offset.fill(0);
            this.requests = 3;
            this.drain(1);
            this.drain(2);
        }
        if(offset === 4 && value === 3 && [0, 0x70, 0xF1, 0xF2, 0x90, 0x3000].includes(this.regs[0x1014 >>> 2]))
        {
            if(this.dma && [0, 0x3000].includes(this.regs[0x1014 >>> 2]))
            {
                this.select_page();
                this.fifo_offset.fill(0);
                this.requests = 3;
                this.drain(1);
                this.drain(2);
                // DMA completion comes from drain() after both channels.
                if(!(this.regs[0] & 1)) this.regs[3] |= 2;
            }
            else this.regs[3] |= 2;
        }
        this.update_irq();
    }

    get_state() { return [this.regs.slice(), this.id_offset, Array.from(this.chips), this.page?.slice() || null, this.column, this.fail, this.requests, this.program?.slice() || null, this.program_address?.slice() || null, Array.from(this.cache), this.page_chip, this.pio_left, Array.from(this.failed_chips), this.fifo_offset.slice()]; }
    set_state(state)
    {
        this.pending.clear();
        this.regs.set(state[0]);
        this.id_offset = state[1];
        this.chips = new Map(state[2]);
        this.page = state[3] || null;
        this.erased = !this.page || this.page.every(byte => byte === 255);
        this.column = state[4] || 0;
        this.fail = !!state[5];
        this.requests = state[6] || 0;
        this.fifo_offset.set(state[13] || [0, 0]);
        this.program = state[7] || null;
        this.program_address = state[8] || null;
        this.failed_chips = new Set(state[12] || (this.fail ? [this.chip()] : []));
        this.page_chip = state[10] ?? this.chip();
        this.pio_left = state[11] || 0;
        this.cache = new Map(state[9] || [[this.chip(), [this.page, this.column, this.erased, this.fail]]]);
        this.update_irq();
    }
}
