// CPU NV40 2D. Independent implementation of MIT envytools rnndb method layouts
// (nv_m2mf.xml, nv1_blit.xml, nv3_gdi.xml and nv1_ctxobj.xml).
const lo = v => v << 16 >> 16;
const hi = v => v >> 16;
const xy = v => [lo(v), hi(v)];
const wh = v => [v & 65535, v >>> 16];
const UPLOAD_COMMITTED = 0x40000;
const INDEX_PROGRESS = 0x40004;
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
        const swizzle = ref && [0x52, 0x9E, 0x309E].includes(ref.class_id);
        if(!ref || !swizzle && ![0x42, 0x62, 0x362, 0x3062].includes(ref.class_id)) throw new RangeError("NV 2D invalid surface");
        const format = m(ref, 0x300) & 255, bpp = format === 1 ? 1 : format >= 2 && format <= 5 ? 2 : format >= 6 && format <= 11 ? 4 : 0;
        if(!bpp) throw new RangeError("NV 2D invalid format");
        const u = m(ref, 0x300) >>> 16 & 255, v = m(ref, 0x300) >>> 24;
        if(swizzle && (u > 12 || v > 12)) throw new RangeError("NV swizzle invalid dimensions");
        const pitch = source ? lo(m(ref, 0x304)) : hi(m(ref, 0x304));
        return { dma: this.dma(ref, swizzle || source ? 0x184 : 0x188), format, bpp, pitch, swizzle, u, v,
            offset: m(ref, swizzle ? 0x304 : source ? 0x308 : 0x30C) };
    }
    address(s, x, y)
    {
        if(!s.swizzle) return s.offset + s.pitch * y + x * s.bpp;
        if(x < 0 || y < 0 || x >= 2 ** s.u || y >= 2 ** s.v) throw new RangeError("NV swizzle outside surface");
        let index = 0, bit = 0;
        for(let i = 0; i < Math.max(s.u, s.v); i++)
        {
            if(i < s.u) index |= (x >>> i & 1) << bit++;
            if(i < s.v) index |= (y >>> i & 1) << bit++;
        }
        return s.offset + index * s.bpp;
    }
    row(surface, x, y, width, write)
    {
        if(x < 0 || y < 0 || width < 0 || !surface.swizzle && width * surface.bpp > Math.abs(surface.pitch)) throw new RangeError("NV 2D invalid rectangle");
        if(surface.swizzle)
        {
            for(let i = 0; i < width; i++) this.device.dma.ranges(surface.dma, this.address(surface, x + i, y), surface.bpp, write);
            return 0;
        }
        const at = surface.offset + surface.pitch * y + x * surface.bpp;
        this.device.dma.ranges(surface.dma, at, width * surface.bpp, write);
        return at;
    }
    readrow(s, x, y, width)
    {
        const at = this.row(s, x, y, width, false);
        if(!s.swizzle) return this.device.dma.read(s.dma, at, width * s.bpp);
        const bytes = new Uint8Array(width * s.bpp);
        for(let i = 0; i < width; i++) bytes.set(this.device.dma.read(s.dma, this.address(s, x + i, y), s.bpp), i * s.bpp);
        return bytes;
    }
    writerow(s, x, y, bytes)
    {
        if(!s.swizzle) this.device.dma.write(s.dma, this.address(s, x, y), bytes);
        else for(let i = 0; i < bytes.length / s.bpp; i++)
            this.device.dma.write(s.dma, this.address(s, x + i, y), bytes.subarray(i * s.bpp, (i + 1) * s.bpp));
    }
    raw(bytes, at, bpp)
    {
        return (bytes[at] | (bpp >= 2 ? bytes[at + 1] << 8 : 0) |
            (bpp === 4 ? bytes[at + 2] << 16 | bytes[at + 3] << 24 : 0)) >>> 0;
    }
    put(bytes, at, bpp, color) { for(let i = 0; i < bpp; i++) bytes[at + i] = color >>> (i * 8) & 255; }
    unpack(color, format)
    {
        if(format === 1) return [color & 255, color & 255, color & 255, 255];
        if(format >= 6) return [color >>> 16 & 255, color >>> 8 & 255, color & 255, format === 10 ? color >>> 24 : 255];
        const green = format === 4 ? 63 : 31;
        return [Math.round((color >>> (format === 4 ? 11 : 10) & 31) * 255 / 31),
            Math.round((color >>> 5 & green) * 255 / green), Math.round((color & 31) * 255 / 31), 255];
    }
    pack(rgba, format)
    {
        const [r, g, b, a] = rgba;
        if(format === 1) return r;
        if(format >= 6) return (a << 24 | r << 16 | g << 8 | b) >>> 0;
        return (r >>> 3) << (format === 4 ? 11 : 10) | (g >>> (format === 4 ? 2 : 3)) << 5 | b >>> 3;
    }
    convert(color, input, output)
    {
        return this.pack(this.input_color(color, input), output);
    }
    input_color(color, input)
    {
        const format = input === 1 ? 4 : input === 2 || input === 3 ? 3 : 10;
        const rgba = this.unpack(color, format);
        if(input === 2) rgba[3] = color & 0x8000 ? 255 : 0;
        else if(input !== 4) rgba[3] = 255;
        return rgba;
    }
    bitmap_format(o)
    {
        // NV40 GROBJ word 1, bits 24..25: drivers can initialize this
        // in RAMIN without ever issuing SET_MONOCHROME_FORMAT.
        return m(o, 0x304, this.device.dma.word(o.instance + 4) >>> 24 & 3 || 2);
    }
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
        const bit = m(p, 0x318 + (index >>> 5) * 4) >>> (this.bitmap_format(p) === 1 ? (index & ~7) % 32 + 7 - (index & 7) : index & 31) & 1;
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
        // Validate every destination row before changing any pixels.
        for(let row = 0; row < h; row++) this.row(dst, x, y + row, w, true);
        const operation = m(o, 0x2FC, 3), rop = o.methods.has(refs[1]) ? this.ref(o, refs[1]) : null;
        if(operation > 5) throw new RangeError("NV 2D invalid operation");
        for(let row = 0; row < h; row++)
        {
            const bytes = this.readrow(dst, x, y + row, w);
            for(let col = 0; col < w; col++)
            {
                const sample = source(x + col, y + row), d = this.raw(bytes, col * dst.bpp, dst.bpp);
                if(sample === null) continue;
                const rgba = Array.isArray(sample) ? sample : this.unpack(sample, dst.format);
                const s = Array.isArray(sample) ? this.pack(rgba, dst.format) : sample;
                const p = this.pattern(o, refs[0], x + col, y + row, dst.format);
                let result = operation === 1 ? this.rop(rop ? m(rop, 0x300) & 255 : 0xCC, s, d, p) : s;
                if(operation === 2 || operation >= 4)
                {
                    const beta = refs.length > 2 && o.methods.has(refs[2]) ? this.ref(o, refs[2]) : null;
                    const beta4 = refs.length > 3 && o.methods.has(refs[3]) ? this.ref(o, refs[3]) : null;
                    const modulation = beta4 ? this.unpack(m(beta4, 0x300), 10) : [255, 255, 255, 255];
                    const alpha = operation === 2 ? beta ? Math.max(0, m(beta, 0x300) | 0) / 2147483647 : 1 : rgba[3] * modulation[3] / 65025;
                    const dest = this.unpack(d, dst.format);
                    const blended = rgba.map((v, i) => Math.min(255, Math.round(operation === 2 ? v * alpha + dest[i] * (1 - alpha) :
                        v * modulation[i] / 255 + (operation === 5 ? dest[i] * (1 - alpha) : 0))));
                    result = this.pack(blended, dst.format);
                }
                this.put(bytes, col * dst.bpp, dst.bpp, result);
            }
            this.writerow(dst, x, y + row, bytes);
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
            rows.push(this.readrow(src, sx + rect[0] - dx, sy + rect[1] - dy + row, rect[2]));
        }
        const key = o.methods.has(0x184) ? this.ref(o, 0x184) : null;
        this.render(o, dst, rect, (x, y) => {
            const s = this.raw(rows[y - rect[1]], (x - rect[0]) * src.bpp, src.bpp);
            return key && s === m(key, 0x304) ? null : s;
        }, [0x18C, 0x190, 0x194, 0x198]);
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
        this.render(o, this.surface(o, 0x198), this.bounds(x, y, w, h, clip), () => color, [0x188, 0x18C, 0x190, 0x194]);
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
    indexed_upload(o, value)
    {
        const [width,height]=wh(m(o,0x3FC)),input=m(o,0x3E8),format=m(o,0x3EC),bpp=format?0.5:1;
        if(!width || !height || width*height*bpp>this.device.vram_size || input<1 || input>5 || format>1)
            throw new RangeError("NV INDEX invalid image/format");
        // INDEX is a packed image stream: a DWORD can cross row boundaries.
        // Old snapshots retained a row and bytes already committed in it.
        const first=m(o,INDEX_PROGRESS,(o.stream[0]||0)*width+m(o,UPLOAD_COMMITTED)/bpp);
        if(first>=width*height)throw new RangeError("NV INDEX excess data");
        const count=Math.min(format?8:4,width*height-first),lutBpp=input<=3?2:4;
        const lut=this.device.dma.read(this.dma(o,0x184),m(o,0x3F0),(format?16:256)*lutBpp);
        const [x,y]=xy(m(o,0x3F4)),[outw,outh]=wh(m(o,0x3F8)),clip=this.clip(o,0x18C),dst=this.surface(o,0x1A0),jobs=[];
        const key=o.methods.has(0x188)?this.ref(o,0x188):null;
        for(let consumed=0;consumed<count;)
        {
            const pixel=first+consumed,row=Math.floor(pixel/width),column=pixel%width,n=Math.min(count-consumed,width-column);
            const rect=this.bounds(x+column,y+row,Math.max(0,Math.min(n,outw-column)),row<outh?1:0,clip);
            if(rect[2] && rect[3])this.row(dst,rect[0],rect[1],rect[2],true);
            jobs.push({rect,column,consumed});consumed+=n;
        }
        const operation=m(o,0x2FC);o.methods.set(0x2FC,m(o,0x3E4));
        try
        {
            for(const {rect,column,consumed}of jobs)this.render(o,dst,rect,px=>{
                const pixel=consumed+px-x-column,shift=format?(pixel>>>1)*8+((pixel&1)^1)*4:pixel*8;
                const index=value>>>shift&(format?15:255),color=this.raw(lut,index*lutBpp,lutBpp);
                return key && color===m(key,0x304)?null:this.input_color(color,input);
            },[0x190,0x194,0x198,0x19C]);
        }
        finally {o.methods.set(0x2FC,operation);}
        o.methods.set(INDEX_PROGRESS,first+count);o.methods.delete(UPLOAD_COMMITTED);
        o.stream=[Math.floor((first+count)/width)];
    }
    upload(o, value, indexed)
    {
        if(indexed)return this.indexed_upload(o,value);
        const base = 0x304, [width, height] = wh(m(o, base + 8));
        const input = m(o, 0x300);
        const bpp = input <= 3 ? 2 : 4;
        if(!width || !height || width * height * bpp > this.device.vram_size || input < 1 || input > 5)
            throw new RangeError("NV IFC invalid image");
        const stride = Math.ceil(width * bpp / 4) * 4;
        if(!o.stream.length) o.stream = [0];
        if(o.stream[0] >= height) throw new RangeError("NV IFC excess data");
        const committed = m(o, UPLOAD_COMMITTED);
        for(let i = 0; i < 4; i++) o.stream.push(value >>> (i * 8) & 255);
        // CPU image methods retire each DWORD immediately. Drivers also use
        // this aperture for a few shader words in a much wider surface row.
        const first = Math.min(width, committed / bpp), last = Math.min(width, (o.stream.length - 1) / bpp);
        const row = o.stream[0], bytes = new Uint8Array(o.stream.slice(1)), [x, y] = xy(m(o, base));
        const [outw, outh] = wh(m(o, base + 4)), dst = this.surface(o, 0x19C);
        const rect = this.bounds(x + first, y + row, Math.max(0, Math.min(last, outw) - first), row < outh ? 1 : 0, this.clip(o, 0x188));
        const key = o.methods.has(0x184) ? this.ref(o, 0x184) : null;
        this.render(o, dst, rect, px => {
            const color = this.raw(bytes, (px - x) * bpp, bpp);
            if(key && color === m(key, 0x304)) return null;
            return this.input_color(color, input);
        }, [0x18C, 0x190, 0x194, 0x198]);
        o.methods.set(UPLOAD_COMMITTED, o.stream.length - 1);
        if(o.stream.length - 1 >= stride)
        {
            o.stream = [row + 1];
            o.methods.delete(UPLOAD_COMMITTED);
        }
    }
    monochrome(o, value, opaque)
    {
        const base = opaque ? 0xBF4 : 0x7F8;
        const [width, height] = wh(m(o, base)), [x, y] = xy(m(o, opaque ? 0xBFC : 0x7FC));
        const offset = o.stream.length ? o.stream[0] : 0;
        if(!width || !height || offset * 32 >= width * height) throw new RangeError("NV GDI bitmap excess data");
        const clipBase = opaque ? 0xBE4 : 0x7EC;
        const clip = [...xy(m(o, clipBase)), ...xy(m(o, clipBase + 4))];
        let outw = width, outh = height;
        if(opaque) [outw, outh] = wh(m(o, 0xBF8));
        const dst = this.surface(o, 0x198);
        for(let consumed = 0; consumed < 32 && offset * 32 + consumed < width * height;)
        {
            const index = offset * 32 + consumed, row = Math.floor(index / width), column = index % width;
            const count = Math.min(32 - consumed, width - column);
            const rect = this.bounds(x + column, y + row, Math.max(0, Math.min(count, outw - column)), row < outh ? 1 : 0, clip);
            this.render(o, dst, rect, px => {
                const bit = consumed + px - x - column, shift = this.bitmap_format(o) === 1 ? (bit & ~7) + 7 - (bit & 7) : bit;
                return value >>> shift & 1 ? m(o, opaque ? 0xBF0 : 0x7F4) : opaque ? m(o, 0xBEC) : null;
            }, [0x188, 0x18C, 0x190, 0x194]);
            consumed += count;
        }
        o.stream = [offset + 1];
    }
    character(o,index,x,y)
    {
        // NVIDIA cl004a: fixed 8..512-byte records, each beginning with a
        // height/width DWORD and followed by packed monochrome DWORDs.
        const font=m(o,0xFF0),pitch=font>>>28;
        if(pitch<3 || pitch>9)throw new RangeError("NV GDI font record pitch");
        const length=1<<pitch,offset=(font&0x0FFFFFFF)+index*length;
        const bytes=this.device.dma.read(this.dma(o,0x184),offset,length),view=new DataView(bytes.buffer);
        const [width,height]=wh(view.getUint32(0,true));
        if(Math.ceil(width*height/32)*4>length-4)throw new RangeError("NV GDI character exceeds font record");
        const clip=[...xy(m(o,0xFF4)),...xy(m(o,0xFF8))],dst=this.surface(o,0x198),format=this.bitmap_format(o);
        this.render(o,dst,this.bounds(x,y,width,height,clip),(px,py)=>{
            const bit=(py-y)*width+px-x,shift=format===1?(bit&~7)%32+7-(bit&7):bit&31;
            return view.getUint32(4+(bit>>>5)*4,true)>>>shift&1?m(o,0xFFC):null;
        },[0x188,0x18C,0x190,0x194]);
    }
    sample(bytes, width, height, pitch, format, x, y)
    {
        x = Math.max(0, Math.min(width - 1, x)); y = Math.max(0, Math.min(height - 1, y));
        const bpp = format === 3 || format === 4 ? 4 : format === 8 ? 1 : 2, at = y * pitch + x * bpp;
        if(format === 5 || format === 6)
        {
            const pair = y * pitch + (x & ~1) * 2;
            const luma = bytes[pair + (format === 5 ? (x & 1) * 2 : 1 + (x & 1) * 2)];
            const u = bytes[pair + (format === 5 ? 1 : 0)] - 128, v = bytes[pair + (format === 5 ? 3 : 2)] - 128;
            const c = (luma - 16) * 298;
            const clamp = n => Math.max(0, Math.min(255, n >> 8));
            return [clamp(c + 409 * v + 128), clamp(c - 100 * u - 208 * v + 128), clamp(c + 516 * u + 128), 255];
        }
        if(format === 8 || format === 9) return [bytes[at], bytes[at], bytes[at], format === 9 ? bytes[at + 1] : 255];
        const raw = this.raw(bytes, at, bpp), rgba = this.unpack(raw, format === 7 ? 4 : format <= 2 ? 3 : 10);
        if(format === 1) rgba[3] = raw & 0x8000 ? 255 : 0;
        else if(format !== 3) rgba[3] = 255;
        return rgba;
    }
    scaled_upload(o, value)
    {
        const [width, height] = wh(m(o, 0x304)), input = m(o, 0x300), bpp = input <= 3 ? 2 : 4;
        const dx = (m(o, 0x308) | 0) / 1048576, dy = (m(o, 0x30C) | 0) / 1048576;
        if(!width || !height || dx <= 0 || dy <= 0 || input < 1 || input > 5) throw new RangeError("NV SIFC invalid image");
        const stride = Math.ceil(width * bpp / 4) * 4;
        if(!o.stream.length) o.stream = [0];
        if(o.stream[0] >= height) throw new RangeError("NV SIFC excess data");
        for(let i = 0; i < 4; i++) o.stream.push(value >>> (i * 8) & 255);
        if(o.stream.length - 1 < stride) return;
        const row = o.stream[0], bytes = new Uint8Array(o.stream.slice(1)), [px, py] = xy(m(o, 0x318));
        const x = px / 16, y = py / 16, [cx, cy] = xy(m(o, 0x310)), [cw, ch] = wh(m(o, 0x314));
        const left = Math.ceil(x - 0.5), right = Math.ceil(x + width * dx - 0.5);
        const top = Math.ceil(y + row * dy - 0.5), bottom = Math.ceil(y + (row + 1) * dy - 0.5);
        const rect = this.bounds(left, top, right - left, bottom - top, [cx, cy, cx + cw, cy + ch]);
        const dst = this.surface(o, 0x198), key = o.methods.has(0x184) ? this.ref(o, 0x184) : null;
        this.render(o, dst, rect, sx => {
            const at = Math.max(0, Math.min(width - 1, Math.floor((sx + 0.5 - x) / dx))) * bpp;
            const color = this.raw(bytes, at, bpp);
            return key && color === m(key, 0x304) ? null : this.input_color(color, input);
        }, [0x188, 0x18C, 0x190, 0x194]);
        o.stream = [row + 1];
    }
    scaled(o)
    {
        const [width, height] = wh(m(o, 0x400)), fmt = m(o, 0x404), pitch = fmt & 65535, format = m(o, 0x300);
        const bpp = format === 3 || format === 4 ? 4 : format === 8 ? 1 : 2;
        // SIZE is a sampling clamp, independent of the DMA row stride. The
        // native driver uses a wide clamp with an 8-byte mip-tail pitch; rows
        // may overlap, and zero pitch repeats the same row.
        const extent=pitch*(height-1)+width*bpp;
        if(!width || !height || extent > this.device.vram_size || format < 1 || format > 9 ||
            ![1,2].includes(fmt>>>16&255) || fmt>>>24>1 ||
            (format === 5 || format === 6) && width & 1) throw new RangeError("NV SIFM invalid image");
        const [x, y] = xy(m(o, 0x310)), [w, h] = wh(m(o, 0x314));
        const [cx, cy] = xy(m(o, 0x308)), [cw, ch] = wh(m(o, 0x30C));
        const rect = this.bounds(x, y, w, h, [cx, cy, cx + cw, cy + ch]);
        const dst = this.surface(o, 0x198), [u0, v0] = xy(m(o, 0x40C));
        const du = (m(o, 0x318) | 0) / 1048576, dv = (m(o, 0x31C) | 0) / 1048576;
        if(!rect[2] || !rect[3])return;
        const center=(fmt>>>16&255)===1,linear=!!(fmt>>>24&1);
        const coordinate=(point,start,origin,step)=>origin/16+(point-start+(center?0.5:0))*step-(center?0.5:0);
        const taps=(first,count,start,origin,step,limit,pairs=false)=>{
            const indices=new Set(),add=value=>{
                value=Math.max(0,Math.min(limit-1,value));
                if(pairs){indices.add(value&~1);indices.add(value|1);}else indices.add(value);
            };
            for(let i=0;i<count;i++)
            {
                const value=Math.floor(coordinate(first+i,start,origin,step)+(linear?0:0.5));
                add(value);if(linear)add(value+1);
            }
            return [...indices].sort((a,b)=>a-b);
        };
        const xs=taps(rect[0],rect[2],x,u0,du,width,format===5 || format===6),ys=taps(rect[1],rect[3],y,v0,dv,height);
        const sx=xs[0],ex=xs[xs.length-1],sy=ys[0],ey=ys[ys.length-1],runs=[];
        for(const col of xs)
        {
            const last=runs[runs.length-1];
            if(last && last[1]+1===col)last[1]=col;else runs.push([col,col]);
        }
        const sampledWidth=ex-sx+1,sampledHeight=ey-sy+1,sampledPitch=sampledWidth*bpp;
        const bytes=new Uint8Array(sampledPitch*sampledHeight),dma=this.dma(o,0x184),offset=m(o,0x408);
        // SIZE clamps sampling; it is not an instruction to read every texel.
        // Preload every used row before any destination write, preserving
        // overlap and atomic faults without touching unmapped unused pages.
        for(const row of ys)for(const [first,last]of runs)
            bytes.set(this.device.dma.read(dma,offset+row*pitch+first*bpp,(last-first+1)*bpp),(row-sy)*sampledPitch+(first-sx)*bpp);
        const operation = m(o, 0x2FC); o.methods.set(0x2FC, m(o, 0x304));
        try
        {
            this.render(o, dst, rect, (px, py) => {
                const u = coordinate(px,x,u0,du)-sx,v=coordinate(py,y,v0,dv)-sy;
                let rgba;
                if(fmt >>> 24 & 1)
                {
                    const ix = Math.floor(u), iy = Math.floor(v), fx = u - ix, fy = v - iy;
                    const a = this.sample(bytes, sampledWidth, sampledHeight, sampledPitch, format, ix, iy), b = this.sample(bytes, sampledWidth, sampledHeight, sampledPitch, format, ix + 1, iy);
                    const c = this.sample(bytes, sampledWidth, sampledHeight, sampledPitch, format, ix, iy + 1), d = this.sample(bytes, sampledWidth, sampledHeight, sampledPitch, format, ix + 1, iy + 1);
                    rgba = a.map((v, i) => Math.round((v * (1 - fx) + b[i] * fx) * (1 - fy) + (c[i] * (1 - fx) + d[i] * fx) * fy));
                }
                else rgba = this.sample(bytes, sampledWidth, sampledHeight, sampledPitch, format, Math.floor(u + 0.5), Math.floor(v + 0.5));
                return rgba;
            }, [0x188, 0x18C, 0x190, 0x194]);
        }
        finally { o.methods.set(0x2FC, operation); }
    }
    line(o, a, b)
    {
        if([...a, ...b].some(v => v < -32768 || v > 32767)) throw new RangeError("NV line coordinate range");
        const dst = this.surface(o, 0x198), clip = this.clip(o, 0x184), color = m(o, 0x304);
        let [x, y] = a;
        const dx = Math.abs(b[0] - x), dy = -Math.abs(b[1] - y), sx = x < b[0] ? 1 : -1, sy = y < b[1] ? 1 : -1;
        let error = dx + dy;
        while(x !== b[0] || y !== b[1])
        {
            this.render(o, dst, this.bounds(x, y, 1, 1, clip), () => color, [0x188, 0x18C, 0x190, 0x194]);
            const twice = error * 2;
            if(twice >= dy) { error += dy; x += sx; }
            if(twice <= dx) { error += dx; y += sy; }
        }
    }
    triangle(o, a, b, c)
    {
        const edge = (p, q, x, y) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
        const area = edge(a, b, c[0], c[1]);
        if(!area) return;
        if(area < 0) [b, c] = [c, b];
        const left = Math.min(a[0], b[0], c[0]), top = Math.min(a[1], b[1], c[1]);
        const rect = this.bounds(left, top, Math.max(a[0], b[0], c[0]) - left, Math.max(a[1], b[1], c[1]) - top, this.clip(o, 0x184));
        const inside = (p, q, x, y) => { const e = edge(p, q, x, y); return e > 0 || e === 0 && (q[1] < p[1] || q[1] === p[1] && q[0] > p[0]); };
        this.render(o, this.surface(o, 0x198), rect, (x, y) => inside(a,b,x+0.5,y+0.5) && inside(b,c,x+0.5,y+0.5) && inside(c,a,x+0.5,y+0.5) ? m(o,0x304) : null,
            [0x188,0x18C,0x190,0x194]);
    }
    solid(o, at, value)
    {
        const line = o.class_id === 0x5C || o.class_id === 0x305C;
        const triangle = o.class_id === 0x5D;
        if(line && at >= 0x400 && at < 0x480 && at & 4) this.line(o, xy(m(o, at-4)), xy(value));
        else if(line && at >= 0x480 && at < 0x500 && (at & 15) === 12)
            this.line(o, [m(o,at-12)|0,m(o,at-8)|0], [m(o,at-4)|0,value|0]);
        else if(line && at >= 0x500 && at < 0x580)
        {
            if(at > 0x500 && o.stream.length) this.line(o,o.stream,xy(value));
            o.stream = xy(value);
        }
        else if(line && at >= 0x580 && at < 0x600 && at & 4)
        {
            const p = [m(o,at-4)|0,value|0];
            if(at > 0x584 && o.stream.length) this.line(o,o.stream,p);
            o.stream = p;
        }
        else if(line && at >= 0x600 && at < 0x680)
        {
            if(!(at & 4)) o.methods.set(0x304,value);
            else
            {
                if(at > 0x604 && o.stream.length) this.line(o,o.stream,xy(value));
                o.stream = xy(value);
            }
        }
        else if(triangle && at === 0x318) this.triangle(o,xy(m(o,0x310)),xy(m(o,0x314)),xy(value));
        else if(triangle && at === 0x334) this.triangle(o,[m(o,0x320)|0,m(o,0x324)|0],[m(o,0x328)|0,m(o,0x32C)|0],[m(o,0x330)|0,value|0]);
        else if(triangle && at >= 0x400 && at < 0x500)
        {
            if(at >= 0x480 && !(at & 4)) return;
            if(at === 0x400 || at === 0x484) o.stream = [];
            const p = at < 0x480 ? xy(value) : [m(o,at-4)|0,value|0];
            if(o.stream.length === 4) this.triangle(o,o.stream.slice(0,2),o.stream.slice(2),p);
            o.stream.push(...p);if(o.stream.length>4)o.stream.splice(0,2);
        }
        else if(triangle && at >= 0x500 && at < 0x580)
        {
            if(!(at & 15)) o.methods.set(0x304,value);
            else if((at & 15) === 12) this.triangle(o,xy(m(o,at-8)),xy(m(o,at-4)),xy(value));
        }
        else if(triangle && at >= 0x580 && at < 0x600)
        {
            if(!(at & 4)) o.methods.set(0x304,value);
            else
            {
                if(at === 0x584) o.stream=[];
                const p=xy(value);
                if(o.stream.length===4)this.triangle(o,o.stream.slice(0,2),o.stream.slice(2),p);
                o.stream.push(...p);if(o.stream.length>4)o.stream.splice(0,2);
            }
        }
    }
    method(o, at, value)
    {
        const type = o.class_id;
        const ifc = [0x61, 0x65, 0x8A, 0x308A].includes(type), indexed = [0x60, 0x64, 0x3064].includes(type);
        const sifc = [0x76, 0x66, 0x3066].includes(type);
        const solid = [0x5C, 0x305C, 0x5D].includes(type);
        let accepted = false;
        if(type === 0x39) accepted = [0x184, 0x188, 0x30C, 0x310, 0x314, 0x318, 0x31C, 0x320, 0x324, 0x328].includes(at);
        else if(type === 0x5F || type === 0x9F) accepted = at >= 0x184 && at <= 0x19C || [0x2FC, 0x300, 0x304, 0x308].includes(at);
        else if(type === 0x4A) accepted = at >= 0x184 && at <= 0x198 || [0x2FC, 0x300, 0x304, 0x3FC, 0x5F4, 0x5F8, 0x5FC, 0xFF0, 0xFF4, 0xFF8, 0xFFC, 0x17F0, 0x17F4, 0x17F8, 0x17FC].includes(at) || at >= 0x400 && at < 0x500 || at >= 0x600 && at < 0x700 || at >= 0x7EC && at < 0xA00 || at >= 0xBE4 && at < 0xE00 || at>=0x1000 && at<0x1400 || at>=0x1800 && at<0x2000;
        else if(ifc) accepted = at >= 0x184 && at <= 0x19C || at >= 0x2F8 && at <= 0x30C || at >= 0x400 && at < 0x2000;
        else if(indexed) accepted = at >= 0x184 && at <= 0x1A0 || at >= 0x3E0 && at < 0x2000;
        else if([0x77, 0x89, 0x3089].includes(type)) accepted = at >= 0x184 && at <= 0x198 || at >= 0x2FC && at <= 0x31C || at >= 0x400 && at <= 0x40C;
        else if(sifc) accepted = at >= 0x184 && at <= 0x198 || at >= 0x2F8 && at <= 0x318 || at >= 0x400 && at < 0x2000;
        else if(solid) accepted = at >= 0x184 && at <= 0x198 || [0x2FC,0x300,0x304].includes(at) ||
            (type===0x5D ? at>=0x310 && at<=0x318 || at>=0x320 && at<=0x334 || at>=0x400 && at<0x600 : at>=0x400 && at<0x680);
        if(!accepted || at & 3) return false;
        o.methods.set(at, value >>> 0);
        if(type === 0x4A)
        {
            if(at===0xFF0 || at===0x17F0)
            {
                if(value>>>28<3 || value>>>28>9)throw new RangeError("NV GDI font record pitch");
                o.methods.set(0xFF0,value);o.methods.set(0x17F0,value);
            }
            if(at>=0x1800 && at<0x2000 && !(at&4))o.methods.set(0x1800,value);
            // These methods address common PGRAPH clip/color/image registers,
            // rather than independent storage for each GDI primitive family.
            for(const aliases of [[0x5F4, 0x7EC, 0xBE4, 0xFF4, 0x17F4], [0x5F8, 0x7F0, 0xBE8, 0xFF8, 0x17F8],
                [0x3FC, 0x5FC, 0x7F4, 0xBF0, 0xFFC, 0x17FC], [0x7FC, 0xBFC]])
                if(aliases.includes(at)) for(const alias of aliases) o.methods.set(alias, value >>> 0);
            if(at === 0x7F8 || at === 0xBF4) { o.methods.set(0x7F8, value); o.methods.set(0xBF4, value); }
            if(at === 0x7F8) o.methods.set(0xBF8, value);
        }
        if(type === 0x39 && at === 0x328) this.m2mf(o, value);
        else if((type === 0x5F || type === 0x9F) && at === 0x308) this.blit(o);
        else if(type === 0x4A && (at >= 0x400 && at < 0x500 || at >= 0x600 && at < 0x700) && at & 4) this.rectangle(o, at);
        else if(type === 0x4A && (at === 0x7FC || at === 0xBFC) || ifc && (at === 0x304 || at === 0x30C) || indexed && (at === 0x3F4 || at === 0x3FC) || sifc && at === 0x318) { o.stream = [0]; o.methods.delete(UPLOAD_COMMITTED); o.methods.delete(INDEX_PROGRESS); }
        else if(type === 0x4A && at >= 0x800 && at < 0xA00) this.monochrome(o, value, false);
        else if(type === 0x4A && at >= 0xC00 && at < 0xE00) this.monochrome(o, value, true);
        else if(type===0x4A && at>=0x1000 && at<0x1400)
        {
            const x=value<<12>>20,y=value>>20;o.methods.set(0x1800,(y<<16|x&65535)>>>0);
            this.character(o,value&255,x,y);
        }
        else if(type===0x4A && at>=0x1800 && at<0x2000 && at&4)this.character(o,value&65535,...xy(m(o,0x1800)));
        else if((ifc || indexed) && at >= 0x400) this.upload(o, value, indexed);
        else if([0x77, 0x89, 0x3089].includes(type) && at === 0x40C) this.scaled(o);
        else if(sifc && at >= 0x400) this.scaled_upload(o, value);
        else if(solid) this.solid(o,at,value);
        return true;
    }
}
