// CPU NV40 2D. Independent implementation of MIT envytools rnndb method layouts
// (nv_m2mf.xml, nv1_blit.xml, nv3_gdi.xml and nv1_ctxobj.xml).
const lo = v => v << 16 >> 16;
const hi = v => v >> 16;
const xy = v => [lo(v), hi(v)];
const wh = v => [v & 65535, v >>> 16];
const m = (o, at, fallback = 0) => o.methods.has(at) ? o.methods.get(at) : fallback;

export class NV2D
{
    constructor(graph) { this.graph = graph; this.device = graph.device; }
    ref(o, at)
    {
        if(!o.methods.has(at)) throw new RangeError("NV 2D context unbound");
        const ref = this.graph.object(o.channel, m(o, at) * 16);
        return ref.class_id === 0x30 || ref.class_id === 0x1030 ? null : ref;
    }
    dma(o, at)
    {
        if(!o.methods.has(at)) throw new RangeError("NV 2D DMA unbound");
        return this.device.dma.descriptor(m(o, at) * 16);
    }
    surface(o, at, source = false)
    {
        const ref = this.ref(o, at);
        if(!ref || ![0x42, 0x62, 0x362, 0x3062].includes(ref.class_id)) throw new RangeError("NV 2D invalid surface");
        const format = m(ref, 0x300), bpp = format === 1 ? 1 : format >= 2 && format <= 5 ? 2 : format >= 6 && format <= 11 ? 4 : 0;
        if(!bpp) throw new RangeError("NV 2D invalid format");
        const pitch = source ? lo(m(ref, 0x304)) : hi(m(ref, 0x304));
        return { dma: this.dma(ref, source ? 0x184 : 0x188), format, bpp, pitch, offset: m(ref, source ? 0x308 : 0x30C) };
    }
    row(surface, x, y, width, write)
    {
        if(x < 0 || y < 0 || width < 0 || width * surface.bpp > Math.abs(surface.pitch)) throw new RangeError("NV 2D invalid rectangle");
        const at = surface.offset + surface.pitch * y + x * surface.bpp;
        this.device.dma.ranges(surface.dma, at, width * surface.bpp, write);
        return at;
    }
    raw(bytes, at, bpp)
    {
        return (bytes[at] | (bpp >= 2 ? bytes[at + 1] << 8 : 0) |
            (bpp === 4 ? bytes[at + 2] << 16 | bytes[at + 3] << 24 : 0)) >>> 0;
    }
    put(bytes, at, bpp, color) { for(let i = 0; i < bpp; i++) bytes[at + i] = color >>> (i * 8) & 255; }
    rop(code, s, d, p)
    {
        let out = 0;
        for(let bit = 0; bit < 8; bit++) if(code & 1 << bit)
            out |= (bit & 1 ? d : ~d) & (bit & 2 ? s : ~s) & (bit & 4 ? p : ~p);
        return out >>> 0;
    }
    pattern(o, at, x, y, format)
    {
        if(!o.methods.has(at)) return 0xFFFFFFFF;
        const p = this.ref(o, at);
        if(!p) return 0xFFFFFFFF;
        const shape = m(p, 0x308), select = m(p, 0x30C, 1);
        const index = shape === 1 ? x & 63 : shape === 2 ? y & 63 : (y & 7) * 8 + (x & 7);
        if(select === 2)
        {
            const bpp = format === 1 ? 1 : format < 6 ? 2 : 4;
            const base = bpp === 1 ? 0x400 : bpp === 4 ? 0x700 : format === 4 ? 0x500 : 0x600;
            return m(p, base + Math.floor(index * bpp / 4) * 4) >>> (index * bpp % 4 * 8);
        }
        const bit = m(p, 0x318 + (index >>> 5) * 4) >>> (m(p, 0x304, 2) === 1 ? (index & ~7) % 32 + 7 - (index & 7) : index & 31) & 1;
        return m(p, 0x310 + bit * 4);
    }
    bounds(x, y, width, height, clip)
    {
        const left = Math.max(0, x, clip ? clip[0] : 0), top = Math.max(0, y, clip ? clip[1] : 0);
        const right = Math.min(x + width, clip ? clip[2] : 65536), bottom = Math.min(y + height, clip ? clip[3] : 65536);
        return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
    }
    clip(o, at)
    {
        if(!o.methods.has(at)) return null;
        const c = this.ref(o, at);
        if(!c) return null;
        const [x, y] = xy(m(c, 0x300)), [w, h] = wh(m(c, 0x304));
        return [x, y, x + w, y + h];
    }
    render(o, dst, rect, source, refs)
    {
        const [x, y, w, h] = rect;
        if(!w || !h) return;
        if(w * h * dst.bpp > this.device.vram_size) throw new RangeError("NV 2D rectangle too large");
        const rows = [];
        // Validate every destination row before changing any pixels.
        for(let row = 0; row < h; row++) rows.push(this.row(dst, x, y + row, w, true));
        const operation = m(o, 0x2FC, 3), rop = o.methods.has(refs[1]) ? this.ref(o, refs[1]) : null;
        if(![0, 1, 3].includes(operation)) throw new RangeError("NV 2D blend operation unavailable");
        for(let row = 0; row < h; row++)
        {
            const bytes = this.device.dma.read(dst.dma, rows[row], w * dst.bpp);
            for(let col = 0; col < w; col++)
            {
                const s = source(x + col, y + row), d = this.raw(bytes, col * dst.bpp, dst.bpp);
                if(s === null) continue;
                const p = this.pattern(o, refs[0], x + col, y + row, dst.format);
                this.put(bytes, col * dst.bpp, dst.bpp, operation === 1 ? this.rop(rop ? m(rop, 0x300) & 255 : 0xCC, s, d, p) : s);
            }
            this.device.dma.write(dst.dma, rows[row], bytes);
        }
    }
    blit(o)
    {
        const [sx, sy] = xy(m(o, 0x300)), [dx, dy] = xy(m(o, 0x304)), [w, h] = wh(m(o, 0x308));
        const src = this.surface(o, 0x19C, true), dst = this.surface(o, 0x19C);
        const rect = this.bounds(dx, dy, w, h, this.clip(o, 0x188)), rows = [];
        if(w * h * src.bpp > this.device.vram_size) throw new RangeError("NV blit too large");
        // Capture the source before writing to support all overlapping directions.
        for(let row = 0; row < rect[3]; row++)
        {
            const at = this.row(src, sx + rect[0] - dx, sy + rect[1] - dy + row, rect[2], false);
            rows.push(this.device.dma.read(src.dma, at, rect[2] * src.bpp));
        }
        const key = o.methods.has(0x184) ? this.ref(o, 0x184) : null;
        this.render(o, dst, rect, (x, y) => {
            const s = this.raw(rows[y - rect[1]], (x - rect[0]) * src.bpp, src.bpp);
            return key && s === m(key, 0x304) ? null : s;
        }, [0x18C, 0x190]);
    }
    rectangle(o, at)
    {
        let x, y, w, h, color, clip = null;
        if(at < 0x500)
        {
            const point = m(o, at - 4), size = m(o, at);
            x = hi(point); y = lo(point); w = size >>> 16; h = size & 65535; color = m(o, 0x3FC);
        }
        else
        {
            [x, y] = xy(m(o, at - 4));
            const [right, bottom] = xy(m(o, at)); w = right - x; h = bottom - y;
            clip = [...xy(m(o, 0x5F4)), ...xy(m(o, 0x5F8))]; color = m(o, 0x5FC);
        }
        this.render(o, this.surface(o, 0x198), this.bounds(x, y, w, h, clip), () => color, [0x188, 0x18C]);
    }
    m2mf(o, value)
    {
        const input = this.dma(o, 0x184), output = this.dma(o, 0x188);
        const width = m(o, 0x31C), height = m(o, 0x320), format = m(o, 0x324);
        if(format !== 0x101 || width * height > this.device.vram_size) throw new RangeError("NV M2MF invalid geometry");
        const rows = [], destinations = [];
        // Notifier validity is part of validation, so a bad notifier cannot turn
        // a failed transfer into a partial copy with an apparent completion.
        const notifier = this.dma(o, 0x180);
        this.device.dma.ranges(notifier, 16, 16, true);
        for(let y = 0; y < height; y++)
        {
            const from = m(o, 0x30C) + (m(o, 0x314) | 0) * y, to = m(o, 0x310) + (m(o, 0x318) | 0) * y;
            this.device.dma.ranges(output, to, width, true);
            rows.push(this.device.dma.read(input, from, width)); destinations.push(to);
        }
        for(let y = 0; y < height; y++) this.device.dma.write(output, destinations[y], rows[y]);
        this.graph.notification(o, 16, value === 1);
    }
    method(o, at, value)
    {
        const type = o.class_id;
        let accepted = false;
        if(type === 0x39) accepted = [0x184, 0x188, 0x30C, 0x310, 0x314, 0x318, 0x31C, 0x320, 0x324, 0x328].includes(at);
        else if(type === 0x5F || type === 0x9F) accepted = at >= 0x184 && at <= 0x19C || [0x2FC, 0x300, 0x304, 0x308].includes(at);
        else if(type === 0x4A) accepted = at >= 0x184 && at <= 0x198 || [0x2FC, 0x300, 0x304, 0x3FC, 0x5F4, 0x5F8, 0x5FC].includes(at) || at >= 0x400 && at < 0x500 || at >= 0x600 && at < 0x700;
        if(!accepted || at & 3) return false;
        o.methods.set(at, value >>> 0);
        if(type === 0x39 && at === 0x328) this.m2mf(o, value);
        else if((type === 0x5F || type === 0x9F) && at === 0x308) this.blit(o);
        else if(type === 0x4A && (at >= 0x400 && at < 0x500 || at >= 0x600 && at < 0x700) && at & 4) this.rectangle(o, at);
        return true;
    }
}
