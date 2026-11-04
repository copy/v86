// S5L8930 channel DMA. Bank zero contains two 32-bit channel-enable masks.
// Channels 1..37 have configuration and descriptor registers on a 4 KiB
// stride. At S1 the driver resets and disables them during its probe.
export class AppleCDMA
{
    constructor(cpu, signal = (n, level) => {})
    {
        this.cpu = cpu;
        this.signal = signal;
        this.ports = new Map();
        this.enabled = new Uint32Array(2);
        this.channel = new Uint32Array(38 * 8);
        this.aes = new Uint32Array(0x9000 / 4);
        cpu.io.register_mmio(0x87800000, 0x9000, {
            name: "cdma-aes",
            read: offset => this.aes[offset >>> 2],
            write: (offset, width, value) => { this.aes[offset >>> 2] = Number(value); },
        });
        cpu.io.register_mmio(0x87000000, 0x26000, {
            name: "cdma",
            read: offset => this.read(offset),
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
    }

    read(offset)
    {
        if(offset === 0x10 || offset === 0x14) return this.enabled[(offset - 0x10) >>> 2];
        const n = offset >>> 12, reg = offset & 4095;
        return n && reg < 32 ? this.channel[n * 8 + (reg >>> 2)] : 0;
    }

    write(offset, value)
    {
        if(offset < 8) this.enabled[offset >>> 2] |= value;
        else if(offset < 16) this.enabled[(offset - 8) >>> 2] &= ~value;
        else
        {
            const n = offset >>> 12, reg = offset & 4095;
            if(n && reg === 0)
            {
                if(value === 2) this.channel.fill(0, n * 8, n * 8 + 8);
                else if(value & 1) this.channel[n * 8] = value & 0xFFFF;
                else this.channel[n * 8] &= ~(value & 0x1C0000);
                this.signal(n, false);
                if(value & 1) this.ports.get(this.channel[n * 8 + 2])?.();
            }
            else if(n && reg > 0 && reg < 32) this.channel[n * 8 + (reg >>> 2)] = value;
        }
    }

    // A peripheral read request moves exactly the channel byte count.
    // Validate the entire chain before exposing any bytes in shared DRAM.
    receive(port, source)
    {
        let transferred = false;
        for(let n = 1; n < 38; n++)
        {
            const i = n * 8, control = this.channel[i];
            if(!(control & 1) || this.channel[i + 2] !== port) continue;
            const count = this.channel[i + 3];
            let descriptor = this.channel[i + 5], used = 0;
            const destinations = [], visited = new Set();
            while(used < count && count <= source.length && !visited.has(descriptor) && visited.size < 32)
            {
                const at = this.cpu.ram_offset(descriptor, 16);
                if(at < 0 || (descriptor & 3)) break;
                visited.add(descriptor);
                const d = new DataView(this.cpu.mem8.buffer, this.cpu.mem8.byteOffset + at, 16);
                const flags = d.getUint32(4, true), addr = d.getUint32(8, true), size = d.getUint32(12, true);
                if((control & 0xF00) && (flags & 3) === 2)
                {
                    // Per-segment IV descriptor. The N90 raw-media path
                    // currently stores logical bytes before NAND encryption.
                    descriptor = d.getUint32(0, true);
                    continue;
                }
                if((flags & 1) === 0 || !size || size > count - used || this.cpu.ram_offset(addr, size) < 0) break;
                destinations.push([addr, used, size]);
                used += size;
                descriptor = d.getUint32(0, true);
                if(flags & 0x100) break;
            }
            if(used === count && count)
            {
                for(const [addr, off, size] of destinations)
                    this.cpu.write_blob_physical(source.subarray(off, off + size), addr);
                this.channel[i + 3] = 0;
                this.channel[i] = (control & ~1) | 0x80000;
            }
            else this.channel[i] = (control & ~1) | 0x40000;
            this.signal(n, true);
            transferred = true;
        }
        return transferred;
    }

    reset() { this.enabled.fill(0); this.channel.fill(0); this.aes.fill(0); }
    get_state() { return [this.enabled.slice(), this.channel.slice(), this.aes.slice()]; }
    set_state(state) { this.enabled.set(state[0]); this.channel.set(state[1]); this.aes.set(state[2]); }
}
