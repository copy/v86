// The portrait N90 boot surface in reserved DRAM. Both XNU's boot console
// and the CLCD scanout use 32-bit 0x00RRGGBB pixels.
export const N90_VIDEO = { base: 0x5F700000, width: 640, height: 960, stride: 2560 };

export class AppleCLCD
{
    constructor(cpu, hub, vic)
    {
        this.cpu = cpu;
        this.vic = vic;
        this.hub = hub;
        this.backlight = 2047;
        this.rgba = new Uint8ClampedArray(N90_VIDEO.stride * N90_VIDEO.height);
        this.scanout_bytes = null;
        this.translate = address => address;
        this.shown = new Uint32Array(N90_VIDEO.width * N90_VIDEO.height);
        this.blank = false;
        this.next_blank_scan = 0;
        this.regs = new Uint32Array(0x7000 / 4);
        this.color = new Uint32Array(0x2000 / 4);
        this.dsi = new Uint32Array(0x1000 / 4);
        this.ulps = 0;
        this.panel_on = true;
        this.command = null;
        this.commands = [];
        this.dirty = true;
        this.reset();
        cpu.io.register_mmio(0x89000000, 0x7000, {
            name: "clcd",
            read: offset => this.regs[offset >>> 2],
            write: (offset, width, value) => this.write(offset, Number(value)),
        });
        // The second CLCD region in the N90 tree holds the color engine.
        cpu.io.register_mmio(0x89200000, 0x2000, {
            name: "clcd-color",
            read: offset => this.color[offset >>> 2],
            write: (offset, width, value) => { this.color[offset >>> 2] = offset === 0x50 ? (Number(value) & ~2) | (Number(value) & 1 ? 0 : 2) : Number(value); },
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
        this.color[0x50 >>> 2] = 1;
        this.color[0x60 >>> 2] = (N90_VIDEO.width - 1) << 16 | (N90_VIDEO.height - 1);
        this.ulps = 0;
        this.panel_on = true;
        this.blank = false;
        this.next_blank_scan = 0;
        this.command = null;
        this.commands = [];
        // iBoot leaves the clock lane and all four N90 data lanes enabled.
        // Pinot sends short DCS packets before the first DSIM reconfiguration.
        this.dsi[0x10 >>> 2] = 0x7F;
        this.dsi[0] = 0x10010F;
        this.regs.fill(0);
        this.regs[0x4040 >>> 2] = 1;
        this.regs[0x4048 >>> 2] = N90_VIDEO.stride | 2;
        this.regs[0x4060 >>> 2] = N90_VIDEO.width << 16 | N90_VIDEO.height;
        this.regs[0x4044 >>> 2] = N90_VIDEO.base;
        this.regs[0x1030 >>> 2] = N90_VIDEO.width << 16 | N90_VIDEO.height;
        this.regs[0x1038 >>> 2] = 0x100;
        this.update_irq();
        this.invalidate();
        this.notify_screen_state();
    }

    write(offset, value)
    {
        if(offset === 0x102C) this.regs[offset >>> 2] &= ~value;
        else if(offset === 0x103C) this.command_word(value >>> 0);
        else if(offset === 0x1050 && value & 1) { this.command = null; this.commands = []; }
        else this.regs[offset >>> 2] = value;
        if(offset === 0x1028 || offset === 0x102C) this.update_irq();
    }

    command_word(value)
    {
        if(!this.command)
        {
            if(!(value & 0x80000000)) return;
            // A tagged batch contains register runs. Each run supplies its
            // destination byte offset, word count and successive values.
            // Bit 29 interprets the tag as the target retrace counter.
            this.command = [value & 0xFFFF, value >>> 16 & 0x3FF, 0, 0, [], !!(value & 0x20000000)];
        }
        else
        {
            const command = this.command;
            command[1]--;
            if(command[2])
            {
                if(command[3] < this.regs.byteLength && !(command[3] & 3))
                    command[4].push([command[3], value]);
                command[3] += 4; command[2]--;
            }
            else { command[2] = value >>> 16 & 255; command[3] = value & 0xFFFF; }
        }
        if(this.command[1] === 0)
        {
            if(!this.command[2]) this.commands.push(this.command);
            this.command = null;
        }
    }

    write_dsi(offset, value)
    {
        if(offset === 0 || offset === 0x3C) return;
        const previous = this.dsi[offset >>> 2];
        if(offset === 0x2C) this.dsi[11] &= ~value;
        else this.dsi[offset >>> 2] = value;
        if(offset === 4 && value & 1)
        {
            // A DSIM reset releases the lanes even after a full power-down
            // left them in ULPS with the request bits cleared.
            this.ulps = 0;
            this.dsi[0x14 >>> 2] &= ~15;
            this.dsi[1] = 0;
        }
        // ULPS requests are triggered by rising edges. Apple's wake sequence
        // asserts exit while entry is still set, then drops exit first.
        if(offset === 0x14)
        {
            const request = value & ~previous;
            if(request & 2) this.ulps |= 0x200;
            if(request & 8) this.ulps |= (this.dsi[4] >>> 1 & 15) << 4;
            if(request & 1) this.ulps &= ~0x200;
            if(request & 4) this.ulps &= ~0xF0;
        }
        // Pinot sends Display Off/On as short DCS packets without arguments.
        const packet = value & 0xFF3F;
        if(offset === 0x34 && (packet === 0x2805 || packet === 0x2905))
        {
            this.panel_on = packet === 0x2905;
            this.invalidate();
            this.notify_screen_state();
        }
        const lanes = this.dsi[4] >>> 1 & 15;
        this.dsi[0] = 0x100000 | this.ulps | (this.ulps & 0x200 ? 0 : 0x100) |
            (lanes & ~(this.ulps >>> 4)) | (this.dsi[2] >>> 31) << 10 |
            (this.dsi[0x4C >>> 2] & 1 << 23 ? 0x80000000 : 0);
    }

    vblank_period() { return 1000 / 60; }
    update_irq()
    {
        this.vic.set_line(42, !!(this.regs[0x1028 >>> 2] & this.regs[0x102C >>> 2]));
    }

    on_vblank()
    {
        if(this.color[0x50 >>> 2] & 1)
        {
            const frame = this.regs[0x1034 >>> 2] = (this.regs[0x1034 >>> 2] + 1) & 0xFFFF;
            while(this.commands.length)
            {
                const command = this.commands[0];
                if(command[5] && (frame - command[0] & 0x8000)) break;
                this.commands.shift();
                for(const [offset, value] of command[4]) this.regs[offset >>> 2] = value;
                this.regs[0x1048 >>> 2] = command[0];
                this.regs[0x102C >>> 2] |= 0x100;
                // The next scan compares the selected surface with shown.
                // A tag or buffer flip does not change the color transform;
                // reserve full recoloring for backlight/panel state changes.
            }
            this.regs[0x102C >>> 2] |= 1;
            this.update_irq();
        }
        // Retrace drives guest interrupts and command completion. The
        // presenter requests pixels separately; scanning here as well
        // reads the entire panel twice per displayed frame.
    }
    invalidate() { this.dirty = true; }

    set_backlight(level)
    {
        if(this.backlight !== level)
        {
            this.backlight = level;
            this.invalidate();
            this.notify_screen_state();
        }
    }

    notify_screen_state()
    {
        this.cpu.bus?.send("ios-screen-state", { "awake": this.panel_on && this.backlight > 0,
            "panel_on": this.panel_on, "backlight": this.backlight });
    }

    // Only a full-panel renderControl post is a scanout. Store its top-down
    // RGBA pixels in the current XRGB window so PMU brightness, VBL and
    // snapshots follow the same path as frames painted by the guest CPU.
    present(rgba, width, height)
    {
        if(width !== N90_VIDEO.width || height !== N90_VIDEO.height || rgba.length !== this.rgba.length) return;
        const base = this.regs[0x4044 >>> 2];
        const pages = this.surface_pages(base, rgba.length);
        if(!pages || (base & 3)) return;
        const bytes = this.scanout_bytes || (this.scanout_bytes = new Uint8Array(rgba.length));
        for(let i = 0; i < bytes.length; i += 4)
        {
            bytes[i] = rgba[i + 2];
            bytes[i + 1] = rgba[i + 1];
            bytes[i + 2] = rgba[i];
            bytes[i + 3] = 0;
        }
        let at = 0;
        for(const [physical, length] of pages)
        {
            this.cpu.write_blob_physical(bytes.subarray(at, at + length), physical);
            at += length;
        }
        this.next_blank_scan = 0;
    }

    surface_pages(base, length)
    {
        const pages = [];
        if(this.cpu.ram_offset(base, length) >= 0) return [[base, length]];
        for(let at = 0; at < length;)
        {
            const address = base + at, size = Math.min(4096 - (address & 4095), length - at);
            const physical = this.translate(address);
            if(physical < 0 || this.cpu.ram_offset(physical, size) < 0) return null;
            pages.push([physical, size]); at += size;
        }
        return pages;
    }

    surface_words(base)
    {
        const size = this.rgba.length, offset = this.cpu.ram_offset(base, size);
        if(offset >= 0 && !(offset & 3))
            return new Uint32Array(this.cpu.mem8.buffer, this.cpu.mem8.byteOffset + offset, this.shown.length);
        if(base & 3) return null;
        const pages = this.surface_pages(base, size);
        if(!pages) return null;
        const bytes = this.scanout_bytes || (this.scanout_bytes = new Uint8Array(size));
        let at = 0;
        for(const [physical, length] of pages)
        {
            const offset = this.cpu.ram_offset(physical, length);
            bytes.set(this.cpu.mem8.subarray(offset, offset + length), at); at += length;
        }
        return new Uint32Array(bytes.buffer, bytes.byteOffset, this.shown.length);
    }

    render(now = performance.now())
    {
        if(!this.panel_on || !this.backlight)
        {
            if(!this.dirty) return;
            this.rgba.fill(0);
            for(let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255;
            this.dirty = false;
            this.update_display();
            return;
        }
        // A black boot surface has nothing to animate. Probe it at 10 Hz
        // until pixels appear; real VBL/interrupts stay at 60 Hz. Explicit
        // GPU posts and color changes request a scan immediately.
        if(this.blank && !this.dirty && now < this.next_blank_scan) return;
        const base = this.regs[0x4044 >>> 2];
        const words = this.surface_words(base);
        if(!words) return;
        let changed = this.dirty, any = 0;
        for(let i = 0; i < words.length; i++)
        {
            const p = words[i];
            any |= p;
            if(!this.dirty && p === this.shown[i]) continue;
            changed = true;
            this.shown[i] = p;
            this.rgba[i * 4] = (p >>> 16 & 255) * this.backlight / 2047;
            this.rgba[i * 4 + 1] = (p >>> 8 & 255) * this.backlight / 2047;
            this.rgba[i * 4 + 2] = (p & 255) * this.backlight / 2047;
            this.rgba[i * 4 + 3] = 255;
        }
        this.blank = !(any & 0xFFFFFF);
        this.next_blank_scan = now + 100;
        this.dirty = false;
        if(changed) this.update_display();
    }

    update_display()
    {
        const { width, height } = N90_VIDEO;
        this.hub.update_buffer([{ pixels: { data: this.rgba, width, height }, screen_x: 0, screen_y: 0,
            buffer_x: 0, buffer_y: 0, buffer_width: width, buffer_height: height }]);
    }

    copy_command(command) { return command ? [...command.slice(0, 4), command[4].map(pair => pair.slice()), !!command[5]] : null; }
    get_state()
    {
        return [this.regs.slice(), this.dsi.slice(), this.ulps, this.color.slice(),
            this.copy_command(this.command), this.commands.map(command => this.copy_command(command)), this.panel_on];
    }
    set_state(state)
    {
        this.regs.set(state[0]); this.dsi.set(state[1]); this.ulps = state[2]; this.color.set(state[3]);
        this.command = this.copy_command(state[4]); this.commands = (state[5] || []).map(command => this.copy_command(command));
        this.panel_on = state[6] !== false;
        this.regs[0x1044 >>> 2] = 0;
        this.update_irq(); this.invalidate();
        this.notify_screen_state();
    }
}
