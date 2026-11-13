// NV40 (GeForce 6800 GT AGP silicon on a PCI bus), G0 register probe.
// Register offsets/bit encodings: envytools rnndb (MIT), bus/pmc.xml,
// bus/ptimer.xml, memory/nv10_pfb.xml. Independently implemented here.
// Unknown registers store values for tracing; this does not imply driver support.
import { VGAScreen } from "../vga_core.js";
import { NVTrace } from "./nv_trace.js";
import { NVDisplay } from "./nv_display.js";
import { NVDMA } from "./nv_dma.js";
import { NVFIFO } from "./nv_fifo.js";
import { NVGraph } from "./nv_graph.js";
import { NVRMA } from "./nv_rma.js";

const MMIO_SIZE = 16 << 20;
const RAMIN_SIZE = 1 << 20;
const MMIO_BASE = 0xFD000000;
const RAMIN_BASE = 0xFC000000;
// PTIMER's 56-bit counter occupies timestamp bits 5..60 (envytools bus/ptimer).
const TIMER_MASK = (1n << 61n) - 32n;
const TIMER_LOW = 0xFFFFFFE0n;
/** @param {bigint} value @return {!Array<number>} */
const timer_pair = value => [Number(value & 0xFFFFFFFFn), Number(value >> 32n)];
/** @param {!Array<number>} pair @return {bigint} */
const timer_from_pair = pair => BigInt(pair[0]) | BigInt(pair[1]) << 32n;
const IRQ_BLOCKS = [[0x001100, 0x001140, 28], [0x002100, 0x002140, 8],
    [0x009100, 0x009140, 20], [0x400100, 0x40013C, 12],
    [0x600100, 0x600140, 24], [0x602100, 0x602140, 25]];

export class NVDevice
{
    constructor(machine, options = {})
    {
        this.machine = machine;
        this.vram_size = options.vram_size === undefined ? 256 << 20 : options.vram_size;
        if(this.vram_size !== 128 << 20 && this.vram_size !== 256 << 20)
        {
            throw new Error("geforce_6800: vram_size must be 128 or 256 MiB");
        }
        this.trace = new NVTrace();
        this.vga = new VGAScreen(machine, this.vram_size, { pci: false, display_source: false });
        this.registers = new Map();
        this.display = new NVDisplay(this);
        this.rma = new NVRMA(this);
        this.dma = new NVDMA(this);
        this.graph = new NVGraph(this);
        this.fifo = new NVFIFO(this);
        this.mmio_address = 0;
        this.ramin_address = 0;
        this.mapped_mmio = 0;
        this.mapped_ramin = 0;
        this.timer_epoch = machine.now();
        /** @type {bigint} */
        this.timer_value = 0n;
        this.alarm_remaining = -1;
        /** @type {bigint} */
        this.alarm_sample = 0n;
        this.pci_registered = false;
        this.reset();
        this.move_mmio(MMIO_BASE);
        this.move_ramin(RAMIN_BASE);
        machine.register_pci({
            pci_space: this.create_pci_space(),
            pci_bars: [
                { size: MMIO_SIZE, on_move: base => this.move_mmio(base) },
                { size: this.vram_size, on_move: base => this.move_vram(base) },
                { size: MMIO_SIZE, on_move: base => this.move_ramin(base) },
            ],
            pci_rom_size: 0x10000,
            pci_rom_address: 0xFEB00000,
            on_command_change: () => { this.update_memory_decode(); this.update_irq(); },
            on_config_restore: () => { this.update_memory_decode(); this.update_irq(); },
            on_upstream_change: () => this.update_memory_decode(),
            on_config_write: () => this.config_written(),
        });
        this.pci_registered = true;
        this.update_memory_decode();
        machine.add_timer(() => this.timer());
    }

    create_pci_space()
    {
        const space = new Array(256).fill(0);
        const put32 = (offset, value) => { for(let i = 0; i < 4; i++) space[offset + i] = value >>> (i * 8) & 255; };
        put32(0, 0x004510DE);
        put32(4, 0x00100003); // memory + I/O decode; capabilities present
        put32(8, 0x030000A1);
        put32(0x10, MMIO_BASE);
        put32(0x14, 0xE0000008); // 256 MiB aligned even with 128 MiB configured
        put32(0x18, RAMIN_BASE);
        put32(0x2C, 0x004510DE); // provisional reference subsystem
        put32(0x30, 0xFEB00000);
        space[0x34] = 0x60;
        space[0x3D] = 1; // INTA
        space[0x60] = 1; // PM capability; deliberately no AGP capability
        space[0x62] = 2; // PM 1.1
        return space;
    }

    reset()
    {
        this.registers.clear();
        this.fifo.reset();
        this.graph.reset();
        this.rma.reset();
        // NV40, device nibble 5, stepping A1. G0 must check against driver traces.
        this.registers.set(0x000000, 0x040500A1);
        this.registers.set(0x000200, 0xFFFFFFFF);
        this.registers.set(0x002054, 2);
        this.registers.set(0x003214, 0x10); // CACHE1 empty
        this.registers.set(0x003304, 3); // NV40 CACHE1 UNK104, documented read-only idle value
        this.registers.set(0x400720, 1);
        this.registers.set(0x009200, 1);
        this.registers.set(0x009210, 1);
        this.registers.set(0x10020C, this.vram_size);
        // Post-firmware memory geometry: four 64-bit partitions, one rank,
        // four banks, 8 column bits, 12/13 row bits for 128/256 MiB.
        // A zero column field also breaks the driver's tiled-pitch alignment.
        for(const [offset, value] of this.memory_defaults()) this.registers.set(offset, value);
        this.registers.set(0x101000, 0); // PCI strap, 13.5 MHz crystal
        this.timer_epoch = this.machine.now();
        this.timer_value = 0n;
        this.alarm_remaining = -1;
        this.alarm_sample = 0n;
        if(this.pci_registered) this.machine.lower_irq();
        this.display.reset();
    }

    vram()
    {
        return new Uint8Array(this.machine.wasm_memory.buffer,
            this.machine.mmio_ram_backing(this.vga.lfb_region) >>> 0, this.vram_size);
    }

    memory_defaults()
    {
        return [[0x1218, 0x200], [0x100200, 7],
            [0x100204, 0x01008000 | (this.vram_size === 128 << 20 ? 12 : 13) << 16]];
    }

    move_vram(base)
    {
        this.vga.move_lfb(base);
        this.update_memory_decode();
    }

    update_memory_decode()
    {
        if(!this.pci_registered) return;
        const base = this.vga.lfb_address;
        if(base && this.machine.memory_decoded(base, this.vram_size)) this.machine.mmio_ram_map(this.vga.lfb_region, base);
        else this.machine.mmio_ram_unmap(this.vga.lfb_region);
    }

    config_written()
    {
        // PM capability header/capabilities are read-only. Only the power state
        // and PME enable latch; no PME source is implemented at G0/G1.
        const config = this.machine.pci_config();
        config.set([1, 0, 2, 0], 0x60);
        config[0x64] &= 3; config[0x65] &= 1;
        config[0x66] = config[0x67] = 0;
    }

    move_mmio(base)
    {
        this.mmio_address = base >>> 0;
        this.map_apertures();
    }

    map_apertures()
    {
        if(this.mapped_mmio) this.machine.mmap_unregister_range(this.mapped_mmio, MMIO_SIZE);
        if(this.mapped_ramin) this.machine.mmap_unregister_range(this.mapped_ramin, MMIO_SIZE);
        this.mapped_mmio = this.mapped_ramin = 0;
        const base = this.mmio_address;
        if(base) this.map_mmio(base);
        const ramin = this.ramin_address;
        // Firmware can temporarily assign one BAR another BAR's old base.
        // Map it after the other BAR moves, rather than registering overlapping ranges.
        if(ramin && (!base || ramin + MMIO_SIZE <= base || base + MMIO_SIZE <= ramin)) this.map_ramin(ramin);
    }

    map_mmio(base)
    {
        if(!base) return;
        this.machine.mmap_register_range(base, MMIO_SIZE,
            address => this.decoded(base) ? this.read8((address - base) >>> 0) : 255,
            (address, value) => { if(this.decoded(base)) this.write8((address - base) >>> 0, value); },
            address => this.decoded(base) ? this.read32((address - base) >>> 0) : -1,
            (address, value) => { if(this.decoded(base)) this.write32((address - base) >>> 0, value); });
        this.mapped_mmio = base;
    }

    move_ramin(base)
    {
        this.ramin_address = base >>> 0;
        this.map_apertures();
    }

    map_ramin(base)
    {
        if(!base) return;
        this.machine.mmap_register_range(base, MMIO_SIZE,
            address => this.decoded(base) ? this.ramin_read((address - base) >>> 0) : 255,
            (address, value) => { if(this.decoded(base)) this.ramin_write((address - base) >>> 0, value); });
        this.mapped_ramin = base;
    }

    decoded(base)
    {
        return this.machine.memory_decoded(base, MMIO_SIZE);
    }

    ramin_read(offset)
    {
        // NV40 PRAMIN is the final 1 MiB of VRAM; BAR2 aliases that aperture.
        const value = offset < RAMIN_SIZE ? this.vram()[this.vram_size - RAMIN_SIZE + offset] : 0;
        this.trace.record("ramin", offset, 1, false, value, offset < RAMIN_SIZE);
        return value;
    }

    ramin_write(offset, value)
    {
        if(offset < RAMIN_SIZE)
        {
            this.machine.mmio_ram_write8(this.vga.lfb_region, this.vram_size - RAMIN_SIZE + offset, value);
        }
        this.trace.record("ramin", offset, 1, true, value, offset < RAMIN_SIZE);
    }

    read8(offset)
    {
        if(this.display.mirror(offset))
        {
            const value = this.display.read8(offset);
            this.trace.record("mmio", offset, 1, false, value, true);
            return value;
        }
        if(offset >= 0x700000 && offset < 0x800000) return this.ramin_read(offset - 0x700000);
        if(offset >= 0x300000 && offset < 0x310000)
        {
            const rom = this.machine.handle["vga_bios"]();
            // PROM is a BAR0 window, independent of the expansion-ROM BAR.
            // NV04..NV40's PBUS PCI_NV_20 bit 0 inhibits the PROM reader.
            const value = this.machine.pci_config()[0x50] & 1 ? 0 : rom[offset - 0x300000] || 0;
            this.trace.record("rom", offset - 0x300000, 1, false, value, true);
            return value;
        }
        return this.read32(offset & ~3) >>> ((offset & 3) * 8) & 255;
    }

    write8(offset, value)
    {
        if(this.display.mirror(offset))
        {
            this.display.write8(offset, value);
            this.trace.record("mmio", offset, 1, true, value, true);
            return;
        }
        if(offset >= 0x700000 && offset < 0x800000) { this.ramin_write(offset - 0x700000, value); return; }
        if(offset >= 0x300000 && offset < 0x310000) return;
        const shift = (offset & 3) * 8, mask = 255 << shift;
        this.write_register(offset & ~3, value << shift, mask);
        this.trace.record("mmio", offset, 1, true, value, this.implemented(offset & ~3));
    }

    read32(offset)
    {
        if(this.display.mirror(offset) || offset >= 0x700000 && offset < 0x800000 || offset >= 0x300000 && offset < 0x310000)
        {
            return (this.read8(offset) | this.read8(offset + 1) << 8 |
                this.read8(offset + 2) << 16 | this.read8(offset + 3) << 24) >>> 0;
        }
        let value;
        const fifo_value = this.fifo.read(offset);
        const graph_value = this.graph.read(offset);
        const rma_value = this.rma.read(offset);
        if(fifo_value !== null) value = fifo_value;
        else if(graph_value !== null) value = graph_value;
        else if(rma_value !== null) value = rma_value;
        else if(offset >= 0x1800 && offset < 0x1900)
        {
            const config = this.machine.pci_config(), i = offset - 0x1800;
            value = config[i] | config[i + 1] << 8 | config[i + 2] << 16 | config[i + 3] << 24;
        }
        else if(offset === 0x100) value = this.interrupts();
        else if(offset === 0x9400) value = Number(this.time() & TIMER_LOW);
        else if(offset === 0x9410) value = Number(this.time() >> 32n);
        else value = this.registers.get(offset) || 0;
        this.trace.record("mmio", offset, 4, false, value, this.implemented(offset));
        return value >>> 0;
    }

    write32(offset, value)
    {
        if(this.display.mirror(offset) || offset >= 0x700000 && offset < 0x800000 || offset >= 0x300000 && offset < 0x310000)
        {
            for(let i = 0; i < 4; i++) this.write8(offset + i, value >>> (i * 8) & 255);
            return;
        }
        this.write_register(offset, value, -1);
        this.trace.record("mmio", offset, 4, true, value, this.implemented(offset));
    }

    implemented(offset)
    {
        return [0, 0x100, 0x140, 0x200, 0x1218, 0x322C, 0x3230, 0x3234, 0x3238, 0x323C, 0x3304,
            0x9200, 0x9210, 0x9400, 0x9410, 0x9420, 0x100200, 0x100204, 0x10020C, 0x101000].includes(offset) ||
            this.fifo.implemented(offset) || this.graph.implemented(offset) || this.display.implemented(offset) || this.rma.implemented(offset) ||
            offset >= 0x1800 && offset < 0x1900 || IRQ_BLOCKS.some(([status, enable]) => offset === status || offset === enable);
    }

    write_register(offset, value, mask)
    {
        if(this.rma.write(offset, value, mask)) return;
        if(this.fifo.user(offset) || offset >= 0x90000 && offset < 0x91000)
        {
            const old = this.fifo.read(offset) || 0;
            this.fifo.write(offset, ((old & ~mask) | value & mask) >>> 0);
            return;
        }
        if(offset >= 0x1800 && offset < 0x1900)
        {
            // Use the PCI core, including its BAR/command/readonly semantics.
            if(mask === -1)
            {
                this.machine.handle["pci_config_write"](offset - 0x1800, 4, value);
                return;
            }
            for(let i = 0; i < 4; i++) if(mask >>> (i * 8) & 255)
            {
                this.machine.handle["pci_config_write"](offset - 0x1800 + i, 1, value >>> (i * 8) & 255);
            }
            return;
        }
        if(offset === 0 || offset === 0x3304 || offset === 0x10020C || offset === 0x101000) return;
        const timestamp = offset === 0x9400 || offset === 0x9410 ? this.time() : 0n;
        const old = offset === 0x9400 ? Number(timestamp & TIMER_LOW) :
            offset === 0x9410 ? Number(timestamp >> 32n) : this.registers.get(offset) || 0;
        if(IRQ_BLOCKS.some(([status]) => status === offset))
        {
            this.registers.set(offset, (old & ~(value & mask)) >>> 0);
        }
        else if(offset === 0x100)
        {
            // Only the software interrupt bit is writable in PMC_INTR.
            this.registers.set(offset, ((old & ~(mask & 0x80000000)) | value & mask & 0x80000000) >>> 0);
        }
        else
        {
            if(offset === 0x9200 || offset === 0x9210)
            {
                this.timer_value = this.time();
                this.timer_epoch = this.machine.now();
            }
            this.registers.set(offset, ((old & ~mask) | value & mask) >>> 0);
            if(offset === 0x3204) this.fifo.active = this.registers.get(offset) & 0x10000 ? this.registers.get(offset) & 31 : -1;
            if(offset === 0x9200 || offset === 0x9210) this.registers.set(offset, this.registers.get(offset) & 0xFFFF);
            if(offset === 0x9420) this.registers.set(offset, (this.registers.get(offset) & 0xFFFFFFE0) >>> 0);
            if(offset === 0x9400 || offset === 0x9410)
            {
                const written = BigInt(this.registers.get(offset));
                this.timer_value = (offset === 0x9400 ? timestamp & ~0xFFFFFFFFn | written :
                    timestamp & 0xFFFFFFFFn | written << 32n) & TIMER_MASK;
                this.timer_epoch = this.machine.now();
                if(this.alarm_remaining >= 0)
                {
                    this.alarm_sample = this.timer_value;
                    this.alarm_remaining = Number((BigInt(this.registers.get(0x9420) || 0) - this.alarm_sample) & TIMER_LOW);
                }
            }
            if(offset === 0x322C || offset === 0x3220 && value & 1 ||
                offset === 0x3230 && !(this.registers.get(offset) & 0x80000000))
            {
                try { this.dma.load_cache((this.registers.get(0x322C) || 0) * 16); }
                catch(error)
                {
                    this.registers.set(0x3230, 0);
                    this.registers.set(0x3228, ((this.registers.get(0x3228) || 0) & 0x1FFFFFFF | 6 << 29) >>> 0);
                    this.registers.set(0x2100, (this.registers.get(0x2100) || 0) | 0x1000);
                }
            }
            if(offset === 0x9420)
            {
                this.alarm_sample = this.time();
                this.alarm_remaining = Number((BigInt(this.registers.get(offset) || 0) - this.alarm_sample) & TIMER_LOW);
                this.machine.wake();
            }
        }
        this.graph.written(offset, value & mask);
        this.update_irq();
        if([0x2100, 0x2500, 0x2504, 0x3200, 0x3220, 0x3240, 0x3250, 0x3270].includes(offset)) this.fifo.run();
    }

    /** @return {bigint} */
    time()
    {
        const div = this.registers.get(0x9200) || 0;
        const mul = this.registers.get(0x9210) || 0;
        const ticks = div ? Math.floor(Math.max(0, this.machine.now() - this.timer_epoch) * 1000000 * mul / div / 32) : 0;
        return (this.timer_value + BigInt(ticks) * 32n) & TIMER_MASK;
    }

    timer()
    {
        this.fifo.run();
        if(this.alarm_remaining >= 0)
        {
            const now = this.time();
            this.alarm_remaining -= Number((now - this.alarm_sample) & TIMER_MASK);
            this.alarm_sample = now;
            if(this.alarm_remaining <= 0)
            {
                this.registers.set(0x9100, (this.registers.get(0x9100) || 0) | 1);
                this.alarm_remaining = -1;
                this.update_irq();
            }
        }
        return 1;
    }

    interrupts()
    {
        let value = (this.registers.get(0x100) || 0) & 0x80000000;
        for(const [status, enable, bit] of IRQ_BLOCKS)
        {
            if((this.registers.get(status) || 0) & (this.registers.get(enable) || 0)) value |= 1 << bit;
        }
        return value >>> 0;
    }

    update_irq()
    {
        if(!this.pci_registered) return;
        const enable = this.registers.get(0x140) || 0, pending = this.interrupts();
        if((enable & 1 && pending & 0x7FFFFFFF) || (enable & 2 && pending & 0x80000000)) this.machine.raise_irq();
        else this.machine.lower_irq();
    }

    get_state()
    {
        return [7, this.vram_size, this.vga.get_state(), Array.from(this.registers),
            timer_pair(this.time()), this.alarm_remaining, timer_pair(this.alarm_sample), this.display.get_state(),
            this.fifo.get_state(), this.graph.get_state(), this.rma.get_state()];
    }

    set_state(state)
    {
        if(state[0] < 1 || state[0] > 7) throw new Error("geforce_6800: unsupported state version " + state[0]);
        if(state[1] !== this.vram_size) throw new Error("geforce_6800: snapshot vram_size mismatch");
        this.vga.set_state(state[2]);
        this.registers = new Map(state[3]);
        if(state[0] < 4) for(const [offset, value] of this.memory_defaults())
            if(!this.registers.has(offset)) this.registers.set(offset, value);
        this.timer_value = state[0] >= 3 ? timer_from_pair(state[4]) : BigInt(Math.floor(state[4])) & TIMER_MASK;
        this.timer_epoch = this.machine.now();
        this.alarm_remaining = state[5];
        this.alarm_sample = state[0] >= 3 ? timer_from_pair(state[6]) : BigInt(Math.floor(state[6])) & TIMER_MASK;
        if(state[0] >= 2) this.display.set_state(state[7]);
        else this.display.reset();
        if(state[0] >= 5) this.fifo.set_state(state[8]);
        else this.fifo.reset();
        if(state[0] >= 6) this.graph.set_state(state[9]);
        else this.graph.reset();
        if(state[0] >= 7) this.rma.set_state(state[10]);
        else this.rma.reset();
        this.update_memory_decode();
        this.update_irq();
    }
}
