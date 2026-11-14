// S5L8930 channel DMA. Bank zero contains two 32-bit channel-enable masks.
// Channels 1..37 have configuration and descriptor registers on a 4 KiB
// stride. At S1 the driver resets and disables them during its probe.
import { AES } from "../ios/crypto.js";
import { N90_UID } from "./uid.js";

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
                const previous = this.channel[n * 8];
                const pause = !!(value & 4), resume = !!(previous & 0x200000) && !pause;
                if(value === 2 || (value & 1) && !pause && !resume) this.progress.delete(n);
                if(value === 2)
                {
                    // The native abort path resets configuration, then reads
                    // MAR/descriptor to retire the stopped ring entry.
                    const address = this.channel[n * 8 + 4], descriptor = this.channel[n * 8 + 5];
                    this.channel.fill(0, n * 8, n * 8 + 8);
                    this.channel[n * 8 + 4] = address;
                    this.channel[n * 8 + 5] = descriptor;
                }
                else
                {
                    const status = value & 1 ? 0 : this.channel[n * 8] & 0x1C0000 & ~value;
                    if(value & 0xFFFF || !(value & 0x1C0000)) this.channel[n * 8] = status | (value & (pause ? 0xFFFE : 0xFFFF)) | (pause ? 0x200000 : 0);
                    else this.channel[n * 8] &= ~(value & 0x1C0000);
                }
                this.signal(n, false);
                // Pause acknowledges a stopped burst, not a completed transfer.
                // Keep its descriptor position and remaining byte count intact.
                if(value & 1 && !pause)
                {
                    if(n <= 2) this.run_aes_pair();
                    else this.ports.get(this.channel[n * 8 + 2])?.();
                }
            }
            else if(n && reg > 0 && reg < 32) this.channel[n * 8 + (reg >>> 2)] = value;
        }
    }

    // CDMAAES feeds RAM into channel 1 and drains ciphertext or plaintext
    // into channel 2. Their two descriptor lists may have different splits.
    run_aes_pair()
    {
        const src = 8, dst = 16;
        if(!(this.channel[src] & this.channel[dst] & 1)) return;
        const count = this.channel[src + 3];
        const context = (this.channel[src] >>> 8 & 15) * 1024;
        const config = this.aes[context], mode = config >>> 16 & 3;
        const keyLength = 16 + (config >>> 18 & 3) * 8;
        const source = this.descriptors(src), destination = this.descriptors(dst);
        const keySlot = config >>> 20 & 31;
        const key = keySlot === 0 && keyLength === 16 ? N90_UID : keySlot === 1 && keyLength <= 32 ?
            this.aes_bytes(context + 8, keyLength) : null;
        const valid = key && (mode === 2 || mode === 3) && (config >>> 8 & 255) === 1 &&
            count === this.channel[dst + 3] && !(count & 15) && source && destination;
        if(valid)
        {
            const cipher = new AES(key);
            let iv = this.aes_bytes(context + 4, 16);
            const input = [source, 0, 0], output = [destination, 0, 0];
            for(let remaining = count; remaining;)
            {
                const chunk = new Uint8Array(Math.min(remaining, 16384));
                this.copy_segments(input, chunk, false);
                iv = cipher.cbc(chunk, iv, mode === 2);
                this.copy_segments(output, chunk, true);
                remaining -= chunk.length;
            }
            const view = new DataView(iv.buffer, iv.byteOffset, iv.byteLength);
            for(let i = 0; i < 4; i++) this.aes[context + 4 + i] = view.getUint32(i * 4, true);
            this.channel[src + 3] = this.channel[dst + 3] = 0;
        }
        for(const n of [1, 2])
        {
            this.channel[n * 8] = (this.channel[n * 8] & ~1) | (valid ? 0x80000 : 0x40000);
            this.signal(n, true);
        }
    }

    aes_bytes(word, length)
    {
        const out = new Uint8Array(length), view = new DataView(out.buffer);
        for(let i = 0; i < length / 4; i++) view.setUint32(i * 4, this.aes[word + i], true);
        return out;
    }

    // The IOP can end a descriptor batch and refill it from its interrupt
    // handler while the channel still has bytes outstanding.
    descriptors(i, allow_refill = false)
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
            segments.push([addr, size, descriptor]);
            total += size;
            if(flags & 0x100) return allow_refill || total === count ? segments : null;
        }
        return total && total === count ? segments : null;
    }

    // null: no armed channel; -1: descriptor error; otherwise the number
    // of FIFO bytes still waiting for the IOP to provide another batch.
    transfer(port, bytes, to_ram)
    {
        let result = null;
        for(let n = 1; n < 38; n++)
        {
            const i = n * 8;
            if(!(this.channel[i] & 1) || this.channel[i + 2] !== port) continue;
            let position = this.progress.get(n);
            if(!position)
            {
                const segments = this.descriptors(i, true);
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
            const used = this.copy_segments(position, bytes, to_ram);
            this.channel[i + 3] -= used;
            // The application CPU's driver retires callbacks by comparing
            // this hardware cursor with its descriptor ring. An interrupt
            // alone leaves those callbacks pending forever.
            if((this.channel[i] & 0x10) && position[1])
            {
                const next = position[0][position[1] - 1][2];
                if(next !== undefined) this.channel[i + 5] = next;
            }
            const batch_done = position[1] === position[0].length;
            if(batch_done)
            {
                this.progress.delete(n);
                this.channel[i] = (this.channel[i] & ~1) | 0x80000;
                this.signal(n, true);
            }
            // Short final transfers retire the FIFO request too. A short
            // intermediate batch leaves its unread suffix for the next list.
            const remaining = this.channel[i + 3] ? bytes.length - used : 0;
            result = result === null ? remaining : Math.min(result, remaining);
        }
        return result;
    }

    copy_segments(position, bytes, to_ram)
    {
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
        return used;
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
