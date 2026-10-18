// A screen adapter for Node that keeps the guest's picture, and PNG
// screenshots of it (tests/x64/linux_gpu.mjs, tests/a64/android_boot.mjs)
import fs from "node:fs";
import path from "node:path";
import { deflateSync as deflate_sync } from "node:zlib";

/**
 * A presenter that keeps the guest's picture, for screenshots in node
 */
export class PictureSink
{
    constructor() { this.width = 0; this.height = 0; this.rgba = new Uint8Array(0); this.graphical = false; this.text = []; }
    set_mode(graphical) { this.graphical = graphical; }
    set_size_text(cols, rows) { this.text = Array.from({ length: rows }, () => " ".repeat(cols)); }
    set_size_graphical(width, height) { this.width = width; this.height = height; this.rgba = new Uint8Array(width * height * 4); }
    put_char(row, col, chr) { const line = this.text[row]; if(line !== undefined) this.text[row] = line.slice(0, col) + String.fromCharCode(chr) + line.slice(col + 1); }
    update_cursor() {}
    update_cursor_scanline() {}
    set_font_bitmap() {}
    set_font_page() {}
    clear_screen() {}
    clear_text_state() {}
    update_buffer(layers)
    {
        for(const layer of layers)
        {
            const { pixels } = layer;
            for(let y = 0; y < layer.buffer_height; y++)
            {
                const sy = layer.buffer_y + y, dy = layer.screen_y + y;
                if(dy >= this.height) break;
                const from = (sy * pixels.width + layer.buffer_x) * 4;
                const count = Math.min(layer.buffer_width, this.width - layer.screen_x) * 4;
                this.rgba.set(pixels.data.subarray(from, from + count), (dy * this.width + layer.screen_x) * 4);
            }
        }
    }
    pause() {}
    continue() {}
    destroy() {}
    set_scale() {}
    get_text_screen() { return this.text; }
    get_text_row(y) { return this.text[y] || ""; }
}

/** the picture as <directory>/<name>.png, or null before the first frame */
export function save_png(sink, directory, name)
{
    const { width, height, rgba } = sink;
    if(!width) return null;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for(let y = 0; y < height; y++)
    {
        for(let x = 0; x < width; x++)
        {
            const s = (y * width + x) * 4, d = y * (width * 3 + 1) + 1 + x * 3;
            raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
        }
    }
    const crc = data => { let c = 0xFFFFFFFF; for(const byte of data) { c ^= byte; for(let i = 0; i < 8; i++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (tag, data) => { const body = Buffer.concat([Buffer.from(tag), data]), b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); body.copy(b, 4); b.writeUInt32BE(crc(body), b.length - 4); return b; };
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    const file = path.join(directory, name + ".png");
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflate_sync(raw)), chunk("IEND", Buffer.alloc(0))]));
    return file;
}
