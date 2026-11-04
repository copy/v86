// The portrait N90 boot surface in reserved DRAM. Both XNU's boot console
// and the CLCD scanout use 32-bit 0x00RRGGBB pixels.
export const N90_VIDEO = { base: 0x5F700000, width: 640, height: 960, stride: 2560 };

export class AppleCLCD
{
    constructor(cpu, hub)
    {
        this.cpu = cpu;
        this.hub = hub;
        this.rgba = new Uint8ClampedArray(N90_VIDEO.stride * N90_VIDEO.height);
        this.shown = new Uint32Array(N90_VIDEO.width * N90_VIDEO.height);
        this.regs = new Uint32Array(0x7000 / 4);
        this.color = new Uint32Array(0x2000 / 4);
        this.dsi = new Uint32Array(0x1000 / 4);
        this.ulps = 0;
        this.dirty = true;
        this.reset();
        cpu.io.register_mmio(0x89000000, 0x7000, {
            name: "clcd",
            read: offset => this.regs[offset >>> 2],
            write: (offset, width, value) => { this.regs[offset >>> 2] = Number(value); },
        });
        // The second CLCD region in the N90 tree holds the color engine.
        cpu.io.register_mmio(0x89200000, 0x2000, {
            name: "clcd-color",
            read: offset => this.color[offset >>> 2],
            write: (offset, width, value) => { this.color[offset >>> 2] = Number(value); },
        });
        cpu.io.register_mmio(0x89500000, 0x1000, {
            name: "mipi-dsim",
            read: offset => this.dsi[offset >>> 2],
            write: (offset, width, value) => this.write_dsi(offset, Number(value)),
        });
        hub.add_source(this);
        hub.set_mode(true);
        hub.set_size_graphical(640, 960, 640, 960, 32);
    }

    reset()
    {
        this.dsi.fill(0);
        this.color.fill(0);
        // iBoot leaves the panel timing and window active. AppleCLCD
        // checks both nonzero minus-one dimensions at 0x89200060.
        this.color[0x60 >>> 2] = (N90_VIDEO.width - 1) << 16 | (N90_VIDEO.height - 1);
        this.ulps = 0;
        this.dsi[0] = 0x10010F;
        this.regs.fill(0);
        this.regs[0x4040 >>> 2] = 1;
        this.regs[0x4048 >>> 2] = N90_VIDEO.stride | 2;
        this.regs[0x4060 >>> 2] = N90_VIDEO.width << 16 | N90_VIDEO.height;
        this.regs[0x4044 >>> 2] = N90_VIDEO.base;
        this.regs[0x1030 >>> 2] = N90_VIDEO.width << 16 | N90_VIDEO.height;
        this.invalidate();
    }

    write_dsi(offset, value)
    {
        if(offset === 0 || offset === 0x3C) return;
        if(offset === 0x2C) this.dsi[11] &= ~value;
        else this.dsi[offset >>> 2] = value;
        // The clock and data lanes enter ULPS on request and stay there
        // until the matching exit request. FIFO transfers drain immediately.
        if(offset === 0x14)
        {
            if(value & 2) this.ulps |= 0x200;
            if(value & 8) this.ulps |= (this.dsi[4] >>> 1 & 15) << 4;
            if(value & 1) this.ulps &= ~0x200;
            if(value & 4) this.ulps &= ~0xF0;
        }
        const lanes = this.dsi[4] >>> 1 & 15;
        this.dsi[0] = 0x100000 | this.ulps | (this.ulps & 0x200 ? 0 : 0x100) |
            (lanes & ~(this.ulps >>> 4)) | (this.dsi[2] >>> 31) << 10 |
            (this.dsi[0x4C >>> 2] & 1 << 23 ? 0x80000000 : 0);
        if(offset === 4 && value & 1) this.dsi[1] = 0;
    }

    vblank_period() { return 1000 / 60; }
    on_vblank() { this.render(); }
    invalidate() { this.dirty = true; }

    render()
    {
        const base = this.regs[0x4044 >>> 2];
        const offset = this.cpu.ram_offset(base, this.rgba.length);
        if(offset < 0 || offset % 4) return;
        const words = new Uint32Array(this.cpu.mem8.buffer, this.cpu.mem8.byteOffset + offset, this.shown.length);
        let changed = this.dirty;
        for(let i = 0; i < words.length; i++)
        {
            const p = words[i];
            if(!this.dirty && p === this.shown[i]) continue;
            changed = true;
            this.shown[i] = p;
            this.rgba[i * 4] = p >>> 16 & 255;
            this.rgba[i * 4 + 1] = p >>> 8 & 255;
            this.rgba[i * 4 + 2] = p & 255;
            this.rgba[i * 4 + 3] = 255;
        }
        this.dirty = false;
        if(changed)
        {
            const { width, height } = N90_VIDEO;
            this.hub.update_buffer([{ pixels: { data: this.rgba, width, height }, screen_x: 0, screen_y: 0,
                buffer_x: 0, buffer_y: 0, buffer_width: width, buffer_height: height }]);
        }
    }

    get_state() { return [this.regs.slice(), this.dsi.slice(), this.ulps, this.color.slice()]; }
    set_state(state) { this.regs.set(state[0]); this.dsi.set(state[1]); this.ulps = state[2]; this.color.set(state[3]); this.invalidate(); }
}
