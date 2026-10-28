// PNG screenshots compared (docs/gles-proxy-plan.md E3: the host GPU's
// home screen against the guest's own rendering): a PNG read back to RGBA
// (8-bit RGB or RGBA, any filter, not interlaced), and SSIM over the
// luminance in 8 by 8 windows (Wang et al. 2004's constants), 1 for the
// same picture.
import fs from "node:fs";
import { inflateSync as inflate_sync } from "node:zlib";

/**
 * @param {string} file
 * @return {{width: number, height: number, rgba: !Uint8Array}}
 */
export function read_png(file)
{
    const data = fs.readFileSync(file);
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20), depth = data[24], type = data[25];
    if(depth !== 8 || (type !== 2 && type !== 6) || data[28]) throw new Error(`${file}: an 8-bit RGB or RGBA PNG, not interlaced`);
    const idat = [];
    for(let at = 8; at < data.length;)
    {
        const length = data.readUInt32BE(at), tag = data.toString("latin1", at + 4, at + 8);
        if(tag === "IDAT") idat.push(data.subarray(at + 8, at + 8 + length));
        at += 12 + length;
    }
    const raw = inflate_sync(Buffer.concat(idat));
    const bpp = type === 6 ? 4 : 3, stride = width * bpp;
    const rgba = new Uint8Array(width * height * 4);
    let previous = new Uint8Array(stride);
    for(let y = 0; y < height; y++)
    {
        const filter = raw[y * (stride + 1)];
        const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
        for(let i = 0; i < stride; i++)
        {
            const a = i >= bpp ? line[i - bpp] : 0, b = previous[i], c = i >= bpp ? previous[i - bpp] : 0;
            let p = 0;
            if(filter === 1) p = a;
            else if(filter === 2) p = b;
            else if(filter === 3) p = (a + b) >> 1;
            else if(filter === 4)
            {
                const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
                p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            line[i] = line[i] + p & 255;
        }
        for(let x = 0; x < width; x++)
        {
            rgba.set(line.subarray(x * bpp, x * bpp + 3), (y * width + x) * 4);
            rgba[(y * width + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
        }
        previous = line;
    }
    return { width, height, rgba };
}

/**
 * The mean SSIM of two pictures' luminance, in 8 by 8 windows
 * @param {{width: number, height: number, rgba: !Uint8Array}} a
 * @param {{width: number, height: number, rgba: !Uint8Array}} b the same size
 * @return {number}
 */
export function ssim(a, b)
{
    if(a.width !== b.width || a.height !== b.height) throw new Error(`${a.width}x${a.height} and ${b.width}x${b.height}`);
    const luma = p => Float64Array.from({ length: p.width * p.height }, (_, i) =>
        0.299 * p.rgba[4 * i] + 0.587 * p.rgba[4 * i + 1] + 0.114 * p.rgba[4 * i + 2]);
    const la = luma(a), lb = luma(b);
    const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
    let sum = 0, windows = 0;
    for(let y = 0; y + 8 <= a.height; y += 8)
    {
        for(let x = 0; x + 8 <= a.width; x += 8)
        {
            let ma = 0, mb = 0;
            for(let j = 0; j < 8; j++) for(let i = 0; i < 8; i++) { ma += la[(y + j) * a.width + x + i]; mb += lb[(y + j) * a.width + x + i]; }
            ma /= 64; mb /= 64;
            let va = 0, vb = 0, cov = 0;
            for(let j = 0; j < 8; j++)
            {
                for(let i = 0; i < 8; i++)
                {
                    const da = la[(y + j) * a.width + x + i] - ma, db = lb[(y + j) * a.width + x + i] - mb;
                    va += da * da; vb += db * db; cov += da * db;
                }
            }
            va /= 63; vb /= 63; cov /= 63;
            sum += (2 * ma * mb + C1) * (2 * cov + C2) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
            windows++;
        }
    }
    return sum / windows;
}
