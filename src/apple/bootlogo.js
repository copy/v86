// The 10B329 N90 AppleLogo is a greyscale iBootIm. The second byte is
// transparency (255 = transparent). Composite against black boot VRAM.
import { lzss_decompress } from "../ios/lzss.js";
import { N90_VIDEO } from "./clcd.js";

export function draw_n90_logo(fb, bytes)
{
    const h = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if(bytes.length < 64 || h.getUint32(0) !== 0x69426F6F || h.getUint32(4) !== 0x74496D00 ||
        h.getUint32(12, true) !== 0x6C7A7373 || h.getUint32(16, true) !== 0x67726579)
        throw new Error("expected the N90 grayscale LZSS iBootIm logo");
    const w = h.getUint16(20, true), height = h.getUint16(22, true);
    const x = Math.floor((N90_VIDEO.width - w) / 2) + h.getInt16(24, true);
    const y = Math.floor((N90_VIDEO.height - height) / 2) + h.getInt16(26, true);
    const size = h.getUint32(28, true);
    if(!w || !height || x < 0 || y < 0 || x + w > N90_VIDEO.width || y + height > N90_VIDEO.height ||
        size > bytes.length - 64) throw new Error("invalid N90 logo bounds");
    const pixels = lzss_decompress(bytes.subarray(64, 64 + size), w * height * 2);
    if(pixels.length !== w * height * 2) throw new Error("truncated N90 logo");
    fb.fill(0);
    for(let row = 0; row < height; row++)
    {
        for(let col = 0; col < w; col++)
        {
            const i = 2 * (row * w + col);
            const gray = Math.round(pixels[i] * (255 - pixels[i + 1]) / 255);
            fb[(row + y) * N90_VIDEO.width + x + col] = gray * 0x10101;
        }
    }
}
