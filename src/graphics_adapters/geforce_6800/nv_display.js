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
        this.raster_pending = false;
        this.key = "";
        this.pixels = null;
        this.gamma = new Uint8Array(768);
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
        this.machine.register_write(0x3C9, this, value => this.dac_write(value));
        this.machine.register_read(0x3C9, this, () => this.dac_read());
        for(const port of [0x3BA,0x3DA])this.machine.register_read(port,this,()=>this.status());
        // NV CRTC 1D/1E select independent 32 KiB write/read banks. Keep the
        // VGA core's planar/text path for the legacy pixel format.
        this.machine.mmap_register_range(0xA0000, 0x20000, address => {
            if(!(this.crtc[0x28] & 3)) return this.vga.vga_memory_read(address);
            const at = this.crtc[0x1E] * 0x8000 + address - 0xA0000;
            return address < 0xB0000 && at < this.device.vram_size ? this.device.vram()[at] : 255;
        }, (address, value) => {
            if(!(this.crtc[0x28] & 3)) { this.vga.vga_memory_write(address, value); return; }
            const at = this.crtc[0x1D] * 0x8000 + address - 0xA0000;
            if(address < 0xB0000 && at < this.device.vram_size)
            {
                this.device.vram()[at] = value;
                this.machine.mmio_ram_mark_dirty(this.vga.lfb_region);
            }
        });
        this.hub.add_source(this);
    }

    reset()
    {
        this.crtc.fill(0); this.crtc2.fill(0);
        this.index2 = this.front = 0;
        this.raster_pending = false;
        this.unlocked = false;
        for(let i = 0; i < 256; i++) this.gamma.fill(i, i * 3, i * 3 + 3);
        this.ddc.reset(); this.invalidate();
    }

    dac_write(value)
    {
        const eight = !!(this.reg(0x680600) & 0x100000), index = this.vga.dac_color_index_write;
        const saved = this.vga.dispi_enable_value;
        this.vga.dispi_enable_value = eight ? saved | 0x20 : saved & ~0x20;
        this.vga.port3C9_write(value);
        this.vga.dispi_enable_value = saved;
        this.gamma[index] = eight ? value : (value & 63) * 255 / 63;
    }
    dac_read()
    {
        const saved = this.vga.dispi_enable_value;
        this.vga.dispi_enable_value = this.reg(0x680600) & 0x100000 ? saved | 0x20 : saved & ~0x20;
        const result = this.vga.port3C9_read();
        this.vga.dispi_enable_value = saved;
        return result;
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
        if(port===0x3DA || port===0x3BA)return this.status();
        if(port === 0x3C9) return this.dac_read();
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
        if(port === 0x3C9) { this.dac_write(value); return; }
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
    raster()
    {
        const c=this.crtc,period=this.vblank_period();
        const total=(c[6]|(c[7]&1)<<8|(c[7]&0x20)<<4|(c[0x25]&1)<<10|(c[0x41]&1)<<11)+2;
        const start=c[0x10]|(c[7]&4)<<6|(c[7]&0x80)<<2|(c[0x25]&4)<<8|(c[0x41]&0x10)<<7;
        const duration=(c[0x11]-start)&15 || 16;
        const elapsed=this.hub.time_since_vblank(this.machine.now()),phase=Number.isFinite(elapsed)?Math.max(0,elapsed)%period/period*total:0;
        const line=(start+Math.floor(phase))%total;
        const horizontal=((c[0]|(c[0x2D]&1)<<8)+5)*8,hpos=Math.floor((phase%1)*horizontal);
        const width=((c[1]|(c[0x2D]&2)<<7)+1)*8;
        const height=(c[0x12]|(c[7]&2)<<7|(c[7]&0x40)<<3|(c[0x25]&2)<<9|(c[0x41]&4)<<9)+1;
        return {line,hpos,retrace:phase<duration,blank:hpos>=width || line>=height};
    }
    status()
    {
        if(!(this.crtc[0x28]&3))return this.vga.port3DA_read();
        const raster=this.raster(),retrace=raster.retrace || this.vga.retrace_pending;
        this.vga.retrace_pending=false;this.vga.attribute_controller_index=-1;
        return (raster.blank?1:0)|(retrace?9:0);
    }
    read(offset, mask = -1)
    {
        if(![0x600808,0x600868,0x60086C].includes(offset))return null;
        const raster=this.raster();
        if(offset===0x600868)return raster.line&0x1FFF;
        if(offset===0x60086C)return raster.hpos&0x1FFF;
        const retrace=raster.retrace || this.raster_pending;
        if(mask&0x10000)this.raster_pending=false;
        return (raster.line&0x1FFF)|(raster.blank?0x2000:0)|(retrace?0x10000:0);
    }
    implemented(offset)
    {
        return [0x600800, 0x600808, 0x60080C, 0x600810, 0x600868, 0x60086C, 0x680300, 0x680508, 0x68050C, 0x680520, 0x680578, 0x68057C, 0x680600].includes(offset);
    }

    vblank_period()
    {
        if(!(this.crtc[0x28] & 3)) return this.vga.vblank_period();
        const c = this.crtc, second = !!(this.reg(0x68050C) & 4);
        const pll = this.reg(second ? 0x680520 : 0x680508), m = pll & 255, n = pll >>> 8 & 255;
        const h = ((c[0] | (c[0x2D] & 1) << 8) + 5) * 8;
        const v = (c[6] | (c[7] & 1) << 8 | (c[7] & 0x20) << 4 | (c[0x25] & 1) << 10 | (c[0x41] & 1) << 11) + 2;
        const stage = this.reg(second ? 0x68057C : 0x680578), m2 = stage & 255, n2 = stage >>> 8 & 255;
        const factor = stage & 0x80000000 && m2 && n2 ? n2 / m2 : 1;
        const clock = m && n ? 13500000 * n / m * factor / (1 << (pll >>> 16 & 7)) : 0;
        const period = clock ? h * v * 1000 / clock : 0;
        return period >= 1 && period <= 100 ? period : 1000 / 60;
    }

    on_vblank()
    {
        if(!(this.crtc[0x28] & 3)) this.vga.on_vblank();
        this.raster_pending=true;this.vga.retrace_pending=true;
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
            out[d] = bytes === 1 ? color >>> 16 : this.gamma[(color >>> 16 & 255) * 3];
            out[d + 1] = bytes === 1 ? color >>> 8 : this.gamma[(color >>> 8 & 255) * 3 + 1];
            out[d + 2] = bytes === 1 ? color : this.gamma[(color & 255) * 3 + 2]; out[d + 3] = 255;
        }
        this.cursor(out, src, width, height);
        this.hub.update_buffer([{ pixels: this.pixels, screen_x: 0, screen_y: 0,
            buffer_x: 0, buffer_y: 0, buffer_width: width, buffer_height: height }]);
    }

    cursor(out, src, width, height)
    {
        const cfg = this.reg(0x600810), c = this.crtc;
        if(!(cfg & 1) && !(c[0x31] & 1)) return;
        const size = cfg & 0x10000 ? 64 : 32, lines = (cfg >>> 24 & 7) * 16 || 32;
        const bpp = cfg & 0x1000 ? 4 : 2, double = cfg & 0x10 || c[0x31] & 2 ? 2 : 1;
        const address = this.device.registers.has(0x60080C) ? this.reg(0x60080C) & 0x0FFFFC00 :
            ((c[0x2F] << 24 | (c[0x30] & 127) << 17 | (c[0x31] & 252) << 9) >>> 0);
        if(address + size * lines * bpp > src.length) return;
        const pos = this.reg(0x680300), x0 = pos << 16 >> 16, y0 = pos >> 16;
        for(let y = Math.max(0, -y0); y < lines * double && y + y0 < height; y++)
            for(let x = Math.max(0, -x0); x < size && x + x0 < width; x++)
        {
            const at = address + (Math.floor(y / double) * size + x) * bpp, to = ((y + y0) * width + x + x0) * 4;
            let r, g, b, alpha;
            if(bpp === 4) { b = src[at]; g = src[at + 1]; r = src[at + 2]; alpha = src[at + 3] / 255; }
            else
            {
                const color = src[at] | src[at + 1] << 8;
                if(color === 0x7FFF) { out[to] ^= 255; out[to + 1] ^= 255; out[to + 2] ^= 255; continue; }
                r = (color >>> 10 & 31) * 255 / 31; g = (color >>> 5 & 31) * 255 / 31; b = (color & 31) * 255 / 31; alpha = color >>> 15;
            }
            const factor = bpp === 4 && !(cfg & 0x10000000) ? 1 : alpha;
            out[to] = Math.min(255, r * factor + out[to] * (1 - alpha));
            out[to + 1] = Math.min(255, g * factor + out[to + 1] * (1 - alpha));
            out[to + 2] = Math.min(255, b * factor + out[to + 2] * (1 - alpha));
        }
    }

    get_state() { return [this.crtc, this.crtc2, this.index2, this.unlocked, this.front, this.ddc.get_state(), this.gamma,this.raster_pending]; }
    set_state(s)
    {
        this.crtc.set(s[0]); this.crtc2.set(s[1]);
        [this.index2, this.unlocked, this.front] = s.slice(2, 5);
        this.ddc.set_state(s[5]); this.invalidate();
        this.raster_pending=!!s[7];
        if(s[6]) this.gamma.set(s[6]);
        else for(let i = 0; i < 256; i++) this.gamma.fill(i, i * 3, i * 3 + 3);
    }
}
