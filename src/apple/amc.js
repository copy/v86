import { AMCCodec } from "./amc_codec.js";

// S5L8930 AMC 2.1 control and local memory. Register offsets verified with
// AppleAMC-176 on 10B329; the three ranges come from its original DeviceTree.
// A reset/idle handshake is distinct from completion of a codec/DMA job.
const ENGINES = [0, 0x20, 0x40, 0x60, 0x100, 0x180, 0x200, 0x240, 0x280, 0x2c0];
export const AMC_RAM_BASE = 0x84000000;
export const AMC_RAM_SIZE = 0x40000;

export class AppleAMC
{
    constructor(cpu, signal = () => {}, dma = null)
    {
        this.cpu = cpu;
        this.signal = signal;
        this.regs = new Uint32Array(0x3000 / 4);
        this.mask = new Uint32Array(2);
        this.pending = new Uint32Array(2);
        this.regions = [[AMC_RAM_BASE, AMC_RAM_SIZE], [0x84300000, 0x5000]].map(([base, size]) => {
            const region = cpu.mmio_ram_allocate(size);
            if(region < 0 || !cpu.wm.exports["a64_bus_map_device"](base, 0, size, 0, cpu.device_regions[region].backing))
                throw new Error("Cannot map AMC local memory");
            return region;
        });
        cpu.io.register_mmio(0x84100000, 0x3000, {
            name: "amc",
            read: offset => this.read(offset),
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
        this.on_job = (offset, value) => {};
        this.reset();
        this.codec = dma ? new AMCCodec(this, dma) : null;
    }

    memory(bank = 0)
    {
        const region = this.regions[bank], size = this.cpu.device_regions[region].size;
        return new Uint8Array(this.cpu.wasm_memory.buffer, this.cpu.mmio_ram_backing(region), size);
    }

    local(at, size)
    {
        return Number.isSafeInteger(at) && Number.isSafeInteger(size) && at >= 0 && size >= 0 &&
            at <= AMC_RAM_SIZE && size <= AMC_RAM_SIZE - at;
    }

    read(offset)
    {
        for(let c = 0; c < 2; c++)
        {
            const relative = offset - c * 0x80;
            if(relative === 0xa94) return this.mask[c];
            if(relative === 0xa98 || relative === 0xa9c) return this.pending[c];
        }
        // One physical window covers the local input bounce buffers.
        if(offset === 0xa44) return AMC_RAM_SIZE;
        return this.regs[offset >>> 2] || 0;
    }

    write(offset, value)
    {
        value >>>= 0;
        this.regs[offset >>> 2] = value;
        for(let c = 0; c < 2; c++)
        {
            const relative = offset - c * 0x80;
            if(relative === 0xa8c) this.mask[c] |= value;
            if(relative === 0xa90) this.mask[c] &= ~value;
        }
        if(offset === 0xc48)
        {
            this.pending[0] &= ~value;
            this.regs[0xc4c >>> 2] = value;
        }
        const engine = ENGINES.find(base => offset === base + 0x10);
        if(engine !== undefined)
        {
            // Command 4 stops/resets the engine. Commands 0x10/0x60 release
            // that state; none of these operations consumed audio input.
            this.regs[(engine + 0x14) >>> 2] = value === 4 ? 7 : 0;
        }
        if([0, 0x100, 0x110, 0x984, 0x988, 0x99c].includes(offset)) this.on_job(offset, value);
        this.update_irq();
    }

    complete(sources, controller = 0)
    {
        this.pending[controller] |= sources;
        this.update_irq();
    }

    update_irq()
    {
        // Source bits belong to the controller's shared status handler;
        // they are not individual external VIC line numbers.
        for(let c = 0; c < 2; c++) this.signal(c, !!(this.pending[c] & this.mask[c]));
    }

    reset()
    {
        this.codec?.reset();
        this.regs.fill(0);
        this.mask.fill(0);
        this.pending.fill(0);
        for(let bank = 0; bank < this.regions.length; bank++) this.memory(bank).fill(0);
        this.update_irq();
    }

    get_state()
    {
        if(this.codec?.decoder || this.codec?.busy) throw new Error("Stop the AMC audio stream before saving a snapshot");
        return [this.regs.slice(), this.mask.slice(), this.pending.slice(), this.memory().slice(), this.memory(1).slice()];
    }

    set_state(state)
    {
        this.reset();
        if(!state) return;
        this.regs.set(state[0]); this.mask.set(state[1]); this.pending.set(state[2]);
        this.memory().set(state[3]); this.memory(1).set(state[4]);
        this.update_irq();
    }

    poll() { this.codec?.poll(); }
}
