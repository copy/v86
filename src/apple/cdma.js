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
        this.progress = new Map();
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
                if(value === 2 || (value & 1)) this.progress.delete(n);
                if(value === 2) this.channel.fill(0, n * 8, n * 8 + 8);
                else if(value & 1) this.channel[n * 8] = value & 0xFFFF;
                else this.channel[n * 8] &= ~(value & 0x1C0000);
                this.signal(n, false);
                if(value & 1) this.ports.get(this.channel[n * 8 + 2])?.();
            }
            else if(n && reg > 0 && reg < 32) this.channel[n * 8 + (reg >>> 2)] = value;
        }
    }

    // Validate the whole descriptor chain before exposing the first page.
    // The N90 IOP arms a single CDMA list for as many as sixteen FMI reads.
    descriptors(i)
    {
        const count = this.channel[i + 3], segments = [], visited = new Set();
        let descriptor = this.channel[i + 5], total = 0;
        while(total < count && !visited.has(descriptor) && visited.size < 4096)
        {
            const at = this.cpu.ram_offset(descriptor, 16);
            if(at < 0 || (descriptor & 3)) break;
            visited.add(descriptor);
            const d = new DataView(this.cpu.mem8.buffer, this.cpu.mem8.byteOffset + at, 16);
            const flags = d.getUint32(4, true), addr = d.getUint32(8, true), size = d.getUint32(12, true);
            descriptor = d.getUint32(0, true);
            // The raw medium currently stores bytes before NAND encryption.
            if((this.channel[i] & 0xF00) && (flags & 3) === 2) continue;
            if(!(flags & 1) || !size || size > count - total || this.cpu.ram_offset(addr, size) < 0) break;
            segments.push([addr, size]);
            total += size;
            if(flags & 0x100) break;
        }
        return total && total === count ? segments : null;
    }

    transfer(port, bytes, to_ram)
    {
        let result = 0;
        for(let n = 1; n < 38; n++)
        {
            const i = n * 8;
            if(!(this.channel[i] & 1) || this.channel[i + 2] !== port) continue;
            let position = this.progress.get(n);
            if(!position)
            {
                const segments = this.descriptors(i);
                if(!segments)
                {
                    this.channel[i] = (this.channel[i] & ~1) | 0x40000;
                    this.signal(n, true);
                    result = -1;
                    continue;
                }
                position = [segments, 0, 0];
                this.progress.set(n, position);
            }
            const segments = position[0];
            let used = 0;
            while(used < bytes.length && position[1] < segments.length)
            {
                const [addr, size] = segments[position[1]];
                const offset = position[2], length = Math.min(size - offset, bytes.length - used);
                const part = bytes.subarray(used, used + length);
                if(to_ram) this.cpu.write_blob_physical(part, addr + offset);
                else part.set(this.cpu.read_blob_physical(addr + offset, length));
                used += length;
                position[2] += length;
                if(position[2] === size) { position[1]++; position[2] = 0; }
            }
            this.channel[i + 3] -= used;
            if(!this.channel[i + 3])
            {
                this.progress.delete(n);
                this.channel[i] = (this.channel[i] & ~1) | 0x80000;
                this.signal(n, true);
            }
            if(!result) result = 1;
        }
        return result;
    }

    reset() { this.enabled.fill(0); this.channel.fill(0); this.aes.fill(0); this.progress.clear(); }
    get_state()
    {
        return [this.enabled.slice(), this.channel.slice(), this.aes.slice(),
            Array.from(this.progress, ([n, pos]) => [n, pos.slice()])];
    }
    set_state(state)
    {
        this.enabled.set(state[0]); this.channel.set(state[1]); this.aes.set(state[2]);
        this.progress = new Map((state[3] || []).map(([n, pos]) => [n, pos.slice()]));
    }
}
