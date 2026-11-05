// The imported disk keeps the user's boot inputs in the raw firmware
// partition. The VSVFL map excludes these physical blocks from YAFTL.
import { NAND_DATA, NAND_PAGE, NAND_SLOT, NAND_BLOCK_PAGES, nand_offset } from "../apple/nand_geometry.js";
import { SHA256 } from "../image/sha256.js";

const FIRST_ROW = 7 * NAND_BLOCK_PAGES, ROWS_PER_CHIP = 7 * NAND_BLOCK_PAGES;
const MAX_BYTES = (4 * ROWS_PER_CHIP - 1) * NAND_DATA;
const MAGIC = new TextEncoder().encode("V86N90B");
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const position = n => {
    const chip = Math.floor(n / ROWS_PER_CHIP);
    return [chip >>> 1, chip & 1, FIRST_ROW + n % ROWS_PER_CHIP];
};

export function write_nand_boot(put, kernel, tree, logo = new Uint8Array(0), library = new Uint8Array(0))
{
    const parts = [kernel, tree, logo, library], length = parts.reduce((sum, part) => sum + part.length, 0);
    if(!kernel.length || !tree.length || length > MAX_BYTES) throw new Error("iPhone boot images do not fit the NAND firmware partition");
    const header = new Uint8Array(NAND_PAGE).fill(255), hv = view(header);
    header.set(MAGIC);
    header[7] = 0x32;
    for(const [i, part] of parts.entries())
    {
        hv.setUint32(8 + i * 4, part.length, true);
        header.set(new SHA256().update(part).digest(), 24 + i * 32);
    }
    put(...position(0), header);
    let row = 1, used = 0;
    let page = new Uint8Array(NAND_PAGE).fill(255);
    for(const bytes of parts)
    {
        for(let at = 0; at < bytes.length;)
        {
            const count = Math.min(NAND_DATA - used, bytes.length - at);
            page.set(bytes.subarray(at, at + count), used);
            at += count;
            used += count;
            if(used === NAND_DATA)
            {
                put(...position(row++), page);
                page = new Uint8Array(NAND_PAGE).fill(255);
                used = 0;
            }
        }
    }
    if(used) put(...position(row), page);
}

export async function read_nand_boot(read)
{
    const header = await read(nand_offset(...position(0)), NAND_SLOT);
    if(header.length !== NAND_SLOT || !MAGIC.every((byte, i) => byte === (header[i] ^ 255)))
        throw new Error("This NAND image does not contain iPhone boot files");
    const raw = header.slice(0, 152).map(byte => byte ^ 255), hv = view(raw);
    if(raw[7] !== 0x31 && raw[7] !== 0x32) throw new Error("Unsupported iPhone NAND boot format");
    const count = raw[7] === 0x32 ? 4 : 3, checksums = 8 + count * 4;
    const sizes = Array.from({ length: count }, (_, i) => hv.getUint32(8 + i * 4, true));
    const length = sizes.reduce((sum, size) => sum + size, 0);
    if(!sizes[0] || !sizes[1] || length > MAX_BYTES) throw new Error("Invalid iPhone NAND boot file sizes");
    const files = new Uint8Array(length);
    for(let row = 1, at = 0; at < length;)
    {
        const count = Math.min(128, ROWS_PER_CHIP - row % ROWS_PER_CHIP, Math.ceil((length - at) / NAND_DATA));
        const bytes = await read(nand_offset(...position(row)), count * NAND_SLOT);
        if(bytes.length !== count * NAND_SLOT) throw new Error("Short read from the NAND firmware partition");
        for(let slot = 0; slot < count; slot++)
        {
            const span = Math.min(NAND_DATA, length - at), start = slot * NAND_SLOT;
            for(let b = 0; b < span; b++) files[at + b] = bytes[start + b] ^ 255;
            at += span;
        }
        row += count;
    }
    let offset = 0;
    const [kernel, tree, logo, library] = sizes.map((size, i) => {
        const bytes = files.slice(offset, offset + size);
        offset += size;
        const digest = new SHA256().update(bytes).digest();
        if(!digest.every((byte, b) => byte === raw[checksums + i * 32 + b])) throw new Error("Corrupt iPhone NAND boot file");
        return bytes.buffer;
    });
    return { kernel, tree, logo: logo.byteLength ? logo : null, library: library?.byteLength ? library : null };
}
