// PVRTC1 expansion for WebGPU, which has no native PVRTC texture format.
// Same endpoint rounding as the original guest adapter, outside ARM emulation.
export function pvrtc_bytes(w, h, two)
{
    if(!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096 || w & w - 1 || h & h - 1) return 0;
    return Math.max(w, two ? 16 : 8) * Math.max(h, 8) / (two ? 4 : 2);
}
export function decode_pvrtc(w, h, data, two, alpha)
{
    const size = pvrtc_bytes(w, h, two);
    if(!size || data && data.length !== size) throw new Error("Invalid PVRTC image");
    const output = new Uint8Array(w * h * 4);
    if(!data) return output;
    const bw = two ? 8 : 4, cols = Math.max(2, w / bw), rows = Math.max(2, h / 4);
    const bytes = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // Untwiddle and decode each endpoint once, rather than eight times per texel.
    const words = Array.from({ length: cols * rows }, (_, i) => {
        const x = i % cols, y = Math.floor(i / cols), small = Math.min(cols, rows);
        let index = 0, shift = 0;
        for(let bit = 1; bit < small; bit *= 2, shift++) index |= (y & bit) << shift | (x & bit) << shift + 1;
        index |= ((cols > rows ? x : y) & ~(small - 1)) << shift;
        const modulation = bytes.getUint32(index * 8, true), endpoints = bytes.getUint32(index * 8 + 4, true);
        const colors = [0, 1].map(high => {
            const code = endpoints >>> (16 * high), extend = (v, n) => v << 5 - n | v >>> (2 * n - 5);
            return code & 0x8000 ? [code >>> 10 & 31, code >>> 5 & 31, high ? code & 31 : extend(code >>> 1 & 15, 4), 15] :
                [extend(code >>> 8 & 15, 4), extend(code >>> 4 & 15, 4), high ? extend(code & 15, 4) : extend(code >>> 1 & 7, 3), code >>> 11 & 14];
        });
        return { modulation, endpoints, colors };
    });
    const word = (x, y) => words[(y & rows - 1) * cols + (x & cols - 1)];
    const standard = [0, 3, 5, 8], punch = [0, 4, 14, 8];
    const sample = (word, x, y) => {
        const m = word.modulation;
        if(!two) return (word.endpoints & 1 ? punch : standard)[m >>> (2 * (4 * y + x)) & 3];
        if(!(word.endpoints & 1)) return (m >>> (8 * y + x) & 1) * 8;
        const bit = 8 * y + (x & ~1);
        return !bit || bit === 20 && m & 1 ? (m >>> bit + 1 & 1) * 8 : standard[m >>> bit & 3];
    };
    const sample2 = (x, y) => sample(word(x >>> 3, y >>> 2), x & 7, y & 3);
    const colors = new Int32Array(8);
    for(let y = 0; y < h; y++) for(let x = 0; x < w; x++)
    {
        const cx = x + bw / 2, cy = y + 2, tx = cx & bw - 1, ty = cy & 3;
        const right = Math.floor(cx / bw), bottom = cy >>> 2;
        const corner = [word(right - 1, bottom - 1), word(right, bottom - 1), word(right - 1, bottom), word(right, bottom)];
        const local = corner[(y & 3) < 2 ? (x & bw - 1) < bw / 2 ? 3 : 2 : (x & bw - 1) < bw / 2 ? 1 : 0];
        let mod;
        if(two && local.endpoints & 1 && (x ^ y) & 1)
        {
            const mode = local.modulation & 1 ? local.modulation & 1 << 20 ? 2 : 1 : 0;
            const across = mode === 2 ? 0 : sample2(x - 1, y) + sample2(x + 1, y);
            const down = mode === 1 ? 0 : sample2(x, y - 1) + sample2(x, y + 1);
            mod = across + down + (mode ? 1 : 2) >>> (mode ? 1 : 2);
        }
        else mod = sample(local, x & bw - 1, y & 3);
        for(let pair = 0; pair < 2; pair++) for(let c = 0; c < 4; c++)
        {
            const a = corner[0].colors[pair][c] * (bw - tx) + corner[1].colors[pair][c] * tx;
            const b = corner[2].colors[pair][c] * (bw - tx) + corner[3].colors[pair][c] * tx;
            const n = a * (4 - ty) + b * ty;
            colors[pair * 4 + c] = c === 3 ? (n >>> (two ? 5 : 4)) + (n >>> Number(two)) :
                (n >>> (two ? 7 : 6)) + (n >>> (two ? 2 : 1));
        }
        const transparent = mod === 14, at = 4 * (y * w + x);
        if(transparent) mod = 4;
        for(let c = 0; c < 4; c++) output[at + c] = colors[c] * (8 - mod) + colors[4 + c] * mod >>> 3;
        if(!alpha) output[at + 3] = 255;
        else if(transparent) output[at + 3] = 0;
    }
    return output;
}
