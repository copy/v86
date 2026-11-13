// NV real-mode aperture. Original implementation, using envytools' MIT PRMA
// register layout/signature and NV3+ VGA CRTC 0x38 port selection.
export class NVRMA
{
    constructor(device)
    {
        this.device = device;
        this.address = 0;
        this.partial = 0;
        for(let i = 0; i < 4; i++)
        {
            this.device.machine.register_read(0x3D0 + i, this, () => this.port_read(i, 1),
                i & 1 ? undefined : () => this.port_read(i, 2), i ? undefined : () => this.port_read(0, 4) | 0);
            this.device.machine.register_write(0x3D0 + i, this, value => this.port_write(i, 1, value),
                i & 1 ? undefined : value => this.port_write(i, 2, value), i ? undefined : value => this.port_write(0, 4, value));
        }
    }
    reset() { this.address = this.partial = 0; }
    enabled() { return !!(this.device.display.crtc[0x38] & 1); }
    selected() { return 0x7100 + (this.device.display.crtc[0x38] >>> 1 & 3) * 4; }
    implemented(at) { return at >= 0x7100 && at <= 0x710C; }
    data_read()
    {
        if(!(this.address & 0x80000000)) return this.address > 0xFFFFFF ? 0xFFFFFFFF : this.device.read32(this.address & 0xFFFFFC);
        const at = this.address & 0x7FFFFFFC;
        if(at + 4 > this.device.vram_size) return 0xFFFFFFFF;
        const bytes = this.device.vram();
        return (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
    }
    data_write(value)
    {
        if(!(this.address & 0x80000000))
        {
            if(this.address > 0xFFFFFF) return;
            const at = this.address & 0xFFFFFC;
            if(at >= 0x7100 && at <= 0x710C) return; // no recursive aperture cycles
            this.device.write32(at, value); return;
        }
        const at = this.address & 0x7FFFFFFC;
        if(at + 4 > this.device.vram_size) return;
        new DataView(this.device.vram().buffer, this.device.vram().byteOffset + at, 4).setUint32(0, value >>> 0, true);
        this.device.machine.mmio_ram_mark_dirty(this.device.vga.lfb_region);
    }
    read(at)
    {
        if(at === 0x7100) return 0x2B16D065;
        if(at === 0x7104) return this.address;
        if(at === 0x7108) return this.address >= 0x7100 && this.address <= 0x710C ? 0xFFFFFFFF : this.data_read();
        if(at === 0x710C) return this.partial;
        return null;
    }
    write(at, value, mask)
    {
        if(at === 0x7100) return true;
        if(at === 0x7104) { this.address = ((this.address & ~mask) | value & mask) >>> 0; return true; }
        if(at === 0x7108 || at === 0x710C)
        {
            this.partial = ((this.partial & ~mask) | value & mask) >>> 0;
            if(at === 0x7108 || mask & 0xFF000000) this.data_write(this.partial);
            return true;
        }
        return false;
    }
    port_read(offset, size)
    {
        if(!this.enabled()) return size === 4 ? 0xFFFFFFFF : 2 ** (size * 8) - 1;
        const value = this.read(this.selected()) >>> (offset * 8);
        return size === 4 ? value : value & (2 ** (size * 8) - 1);
    }
    port_write(offset, size, value)
    {
        if(!this.enabled()) return;
        const mask = size === 4 ? -1 : (2 ** (size * 8) - 1) << (offset * 8);
        this.write(this.selected(), value << (offset * 8), mask);
    }
    get_state() { return [this.address, this.partial]; }
    set_state(state) { [this.address, this.partial] = state; }
}
