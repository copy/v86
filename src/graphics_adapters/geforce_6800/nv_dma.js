// NV4/NV40 DMA objects. Encoding reference: nouveau nvkm/engine/dma/usernv04.c
// (MIT), and envytools rnndb/fifo/nv4_pfifo.xml. Original implementation.
// A descriptor lives in PRAMIN; its inclusive limit is relative to its adjusted
// base. System-memory DMA goes through the machine's checked physical API.
export class NVDMA
{
    constructor(device) { this.device = device; }

    word(offset)
    {
        if(!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > 1 << 20 || offset & 3)
            throw new RangeError("NV DMA instance outside RAMIN");
        const bytes = this.device.vram(), at = this.device.vram_size - (1 << 20) + offset;
        return (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
    }

    descriptor(instance)
    {
        const flags = this.word(instance), limit = this.word(instance + 4), pte = this.word(instance + 8);
        const class_id = flags & 0xFFF, target = flags >>> 16 & 3;
        if(![2, 3, 0x3D].includes(class_id)) throw new RangeError("Invalid NV DMA class");
        if(!(flags & 0x1000) || target === 1) throw new RangeError("NV DMA page table unavailable");
        return { instance, flags, limit, pte, class_id, target, adjust: flags >>> 20, linear: !!(flags & 0x2000) };
    }

    ranges(dma, offset, length, write)
    {
        if(!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
            offset + length > dma.limit + 1) throw new RangeError("NV DMA limit exceeded");
        if(write ? dma.class_id === 2 || dma.flags & 0x4000 : dma.class_id === 3 || dma.flags & 0x8000)
            throw new RangeError("NV DMA access denied");
        if(dma.target && !this.device.machine.is_bus_master()) throw new RangeError("NV PCI bus mastering disabled");
        const ranges = [];
        for(let done = 0; done < length;)
        {
            const logical = dma.adjust + offset + done, page = Math.floor(logical / 4096);
            const pte = dma.linear ? dma.pte : this.word(dma.instance + 8 + page * 4);
            if(!dma.linear && !(pte & 1) || write && !(pte & 2)) throw new RangeError("NV DMA page access fault");
            const address = (pte & 0xFFFFF000) >>> 0;
            const at = dma.linear ? address + logical : address + logical % 4096;
            const count = Math.min(length - done, 4096 - logical % 4096);
            if(dma.target) this.device.machine.validate_physical_range(at, count);
            else if(at + count > this.device.vram_size) throw new RangeError("NV DMA outside VRAM");
            ranges.push({ at, count, offset: done });
            done += count;
        }
        return ranges;
    }

    read(dma, offset, length)
    {
        const ranges = this.ranges(dma, offset, length, false), bytes = new Uint8Array(length);
        for(const r of ranges) bytes.set(dma.target ? this.device.machine.read_physical(r.at, r.count) :
            this.device.vram().subarray(r.at, r.at + r.count), r.offset);
        return bytes;
    }

    write(dma, offset, bytes)
    {
        // Validate every page first: a fault never leaves a partial notification.
        const ranges = this.ranges(dma, offset, bytes.length, true);
        for(const r of ranges)
        {
            const part = bytes.subarray(r.offset, r.offset + r.count);
            if(dma.target) this.device.machine.write_physical(part, r.at);
            else this.device.vram().set(part, r.at);
        }
        if(!dma.target && bytes.length) this.device.machine.mmio_ram_mark_dirty(this.device.vga.lfb_region);
    }

    load_cache(instance)
    {
        // VALID acknowledges the instance-memory fetch, not permission to DMA.
        // The driver invalidates this cache even while PUSH is stopped and the
        // instance still contains zeros. Check class/PTE/access on actual DMA.
        const flags = this.word(instance), limit = this.word(instance + 4), pte = this.word(instance + 8);
        const regs = this.device.registers;
        regs.set(0x3230, (0x80000000 | flags & 0x33000 | flags >>> 20 & 0xFFC) >>> 0);
        regs.set(0x3234, limit);
        regs.set(0x3238, 0);
        regs.set(0x323C, pte);
    }
}
