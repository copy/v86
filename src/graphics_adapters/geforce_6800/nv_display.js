// NV40 CRT scanout and VGA MMIO mirrors. Register encodings are documented in
// envytools rnndb/display and nouveau dispnv04/nvreg.h (MIT). Original implementation.
import { make_edid } from "../virtio_gpu/edid.js";
import { NVDDC } from "./nv_ddc.js";

export class NVDisplay
{
    constructor(device)
    {
        this.device = device;
        this.vga = device.vga;
        this.machine = device.machine;
        this.hub = this.machine.display;
        this.crtc = new Uint8Array(256);
        this.crtc2 = new Uint8Array(256);
        this.index2 = 0;
        this.unlocked = false;
        this.front = 0;
        this.key = "";
        this.pixels = null;
        const edid = make_edid(1280, 1024, 0x40);
        edid[20] = 0x08; // analog RGB, separate sync
        edid.set(Array.from("v86 NV40 CRT\n", c => c.charCodeAt(0)), 95);
        edid[127] = 0;
        edid[127] = -edid.reduce((a, b) => a + b, 0) & 255;
        this.ddc = new NVDDC(edid);
        for(const port of [0x3B4, 0x3D4])
        {
            this.machine.register_write(port, this, value => this.vga.port3D4_write(value), value => {
                this.vga.port3D4_write(value & 255); this.write_crtc(value >>> 8 & 255);
            });
            this.machine.register_read(port, this, () => this.vga.index_crtc,
                () => this.vga.index_crtc | this.read_crtc() << 8);
            this.machine.register_write(port + 1, this, value => this.write_crtc(value), value => this.write_crtc(value & 255));
            this.machine.register_read(port + 1, this, () => this.read_crtc(), () => this.read_crtc());
        }
        // A VGA BIOS mode change begins with a sequencer reset, leaving the NV mode.
        this.machine.register_write(0x3C4, this, value => this.vga.port3C4_write(value), value => {
            this.vga.port3C4_write(value & 255); this.write_seq(value >>> 8 & 255);
        });
        this.machine.register_write(0x3C5, this, value => this.write_seq(value));
        this.hub.add_source(this);
    }

    reset()
    {
        this.crtc.fill(0); this.crtc2.fill(0);
        this.index2 = this.front = 0;
        this.unlocked = false;
        this.ddc.reset(); this.invalidate();
    }

    write_seq(value)
    {
        if(this.vga.sequencer_index === 0 && !(value & 1))
        {
            this.crtc[0x28] = 0;
            this.key = "";
            this.vga.invalidate();
        }
        this.vga.port3C5_write(value);
    }

    read_crtc()
    {
        const i = this.vga.index_crtc;
        if(i === 0x1F) return this.unlocked ? 3 : 0;
        if(i === 0x3E || i === 0x36) return this.ddc.scl << 2 | this.ddc.data() << 3;
        return i < 0x19 ? this.vga.port3D5_read() : this.crtc[i] || 0;
    }

    write_crtc(value)
    {
        const i = this.vga.index_crtc;
        if(i === 0x1F) { this.unlocked = value === 0x57; return; }
        if(i >= 0x19 && !this.unlocked) return;
        this.crtc[i] = value;
        if(i < 0x19) this.vga.port3D5_write(value);
        if(i === 0x3F || i === 0x37) this.ddc.drive(value & 0x20, value & 0x10);
    }

    mirror(offset)
    {
        const block = offset & 0xFFF000;
        return [0x0C0000, 0x0C2000, 0x601000, 0x603000, 0x681000, 0x683000].includes(block);
    }

    read8(offset)
    {
        const port = offset & 0xFFF, second = !!(offset & 0x2000);
        if(port === 0x3D4 || port === 0x3B4) return second ? this.index2 : this.vga.index_crtc;
        if(port === 0x3D5 || port === 0x3B5) return second ? this.crtc2[this.index2] : this.read_crtc();
        if(second) return 255; // disconnected second head
        const readers = { 0x3C0: "port3C0_read", 0x3C1: "port3C1_read", 0x3C4: "port3C4_read", 0x3C5: "port3C5_read",
            0x3C6: "port3C6_read", 0x3C7: "port3C7_read", 0x3C8: "port3C8_read", 0x3C9: "port3C9_read",
            0x3CC: "port3CC_read", 0x3CE: "port3CE_read", 0x3CF: "port3CF_read", 0x3DA: "port3DA_read", 0x3BA: "port3DA_read" };
        return readers[port] ? this.vga[readers[port]]() : 255;
    }

    write8(offset, value)
    {
        const port = offset & 0xFFF, second = !!(offset & 0x2000);
        if(port === 0x3D4 || port === 0x3B4) { if(second) this.index2 = value; else this.vga.port3D4_write(value); return; }
        if(port === 0x3D5 || port === 0x3B5) { if(second) this.crtc2[this.index2] = value; else this.write_crtc(value); return; }
        if(second) return;
        if(port === 0x3C5) { this.write_seq(value); return; }
        const writers = { 0x3C0: "port3C0_write", 0x3C2: "port3C2_write", 0x3C4: "port3C4_write",
            0x3C6: "port3C6_write", 0x3C7: "port3C7_write", 0x3C8: "port3C8_write", 0x3C9: "port3C9_write",
            0x3CE: "port3CE_write", 0x3CF: "port3CF_write" };
        if(writers[port]) this.vga[writers[port]](value);
    }

    mode()
    {
        const c = this.crtc, format = c[0x28] & 3;
        if(!format) return null;
        const width = ((c[1] | (c[0x2D] & 2) << 7) + 1) * 8;
        const height = (c[0x12] | (c[7] & 2) << 7 | (c[7] & 0x40) << 3 | (c[0x25] & 2) << 9 | (c[0x41] & 4) << 9) + 1;
        const pitch = (c[0x13] | (c[0x19] & 0xE0) << 3 | (c[0x42] & 0x40) << 5) * 8;
        const bytes = [0, 1, 2, 4][format];
        if(width < 8 || width > 2048 || height > 1536 || pitch < width * bytes ||
            this.front + (height - 1) * pitch + width * bytes > this.device.vram_size) return null;
        return { width, height, pitch, bytes, rgb565: !!(this.reg(0x680600) & 0x1000) };
    }

    reg(offset) { return this.device.registers.get(offset) || 0; }

    vblank_period()
    {
        if(!(this.crtc[0x28] & 3)) return this.vga.vblank_period();
        const c = this.crtc, pll = this.reg(0x680508), m = pll & 255, n = pll >>> 8 & 255;
        const h = ((c[0] | (c[0x2D] & 1) << 8) + 5) * 8;
        const v = (c[6] | (c[7] & 1) << 8 | (c[7] & 0x20) << 4 | (c[0x25] & 1) << 10 | (c[0x41] & 1) << 11) + 2;
        const clock = m && n ? 13500000 * n / m / (1 << (pll >>> 16 & 7)) : 0;
        const period = clock ? h * v * 1000 / clock : 0;
        return period >= 1 && period <= 100 ? period : 1000 / 60;
    }

    on_vblank()
    {
        if(!(this.crtc[0x28] & 3)) this.vga.on_vblank();
        this.front = this.reg(0x600800) & 0x0FFFFFFC;
        this.device.registers.set(0x600100, this.reg(0x600100) | 1);
        this.device.update_irq();
    }

    invalidate() { this.key = ""; this.vga.invalidate(); }

    render()
    {
        const mode = this.mode();
        if(!mode)
        {
            if(this.key)
            {
                this.key = ""; this.vga.invalidate(); this.vga.size_reported = false;
                this.hub.set_mode(this.vga.graphical_mode);
                if(this.vga.graphical_mode) this.hub.set_size_graphical(this.vga.screen_width, this.vga.screen_height,
                    this.vga.virtual_width, this.vga.virtual_height, this.vga.svga_bpp);
                else this.hub.set_size_text(this.vga.max_cols, this.vga.max_rows);
            }
            this.vga.render();
            return;
        }
        const { width, height, pitch, bytes, rgb565 } = mode;
        const key = [width, height, bytes].join(":");
        if(key !== this.key)
        {
            this.key = key;
            this.pixels = { data: new Uint8Array(width * height * 4), width, height };
            this.hub.set_mode(true);
            this.hub.set_size_graphical(width, height, width, height, bytes * 8);
        }
        const src = this.device.vram(), out = this.pixels.data;
        for(let y = 0; y < height; y++) for(let x = 0; x < width; x++)
        {
            const s = this.front + y * pitch + x * bytes, d = (y * width + x) * 4;
            let color;
            if(bytes === 1) color = this.vga.vga256_palette[src[s] & this.vga.dac_mask];
            else if(bytes === 2)
            {
                const value = src[s] | src[s + 1] << 8;
                const r = value >>> (rgb565 ? 11 : 10) & 31, g = value >>> 5 & (rgb565 ? 63 : 31), b = value & 31;
                color = (r * 255 / 31 << 16) | (g * 255 / (rgb565 ? 63 : 31) << 8) | b * 255 / 31;
            }
            else color = src[s + 2] << 16 | src[s + 1] << 8 | src[s];
            out[d] = color >>> 16; out[d + 1] = color >>> 8; out[d + 2] = color; out[d + 3] = 255;
        }
        this.hub.update_buffer([{ pixels: this.pixels, screen_x: 0, screen_y: 0,
            buffer_x: 0, buffer_y: 0, buffer_width: width, buffer_height: height }]);
    }

    get_state() { return [this.crtc, this.crtc2, this.index2, this.unlocked, this.front, this.ddc.get_state()]; }
    set_state(s)
    {
        this.crtc.set(s[0]); this.crtc2.set(s[1]);
        [this.index2, this.unlocked, this.front] = s.slice(2, 5);
        this.ddc.set_state(s[5]); this.invalidate();
    }
}
