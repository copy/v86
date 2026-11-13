// The imported disk keeps the user's boot inputs in the raw firmware
// partition. The VSVFL map excludes these physical blocks from YAFTL.
import { NAND_DATA, NAND_PAGE, NAND_SLOT, NAND_BLOCK_PAGES, nand_offset } from "../apple/nand_geometry.js";
import { SHA256 } from "../image/sha256.js";
import { validate_install_state, install_hashes } from "./install_trust.js";
import { n90_kernel_hashes } from "./guest_load.js";

const FIRST_ROW = 7 * NAND_BLOCK_PAGES, ROWS_PER_CHIP = 7 * NAND_BLOCK_PAGES;
const MAX_BYTES = (4 * ROWS_PER_CHIP - 1) * NAND_DATA;
const BANK_PAGES = 2 * ROWS_PER_CHIP;
export const NAND_BOOT_BANK_BYTES = (BANK_PAGES - 1) * NAND_DATA;
const MAGIC = new TextEncoder().encode("V86N90B");
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const position = n => {
    const chip = Math.floor(n / ROWS_PER_CHIP);
    return [chip >>> 1, chip & 1, FIRST_ROW + n % ROWS_PER_CHIP];
};

export function write_nand_boot(put, kernel, tree, logo = new Uint8Array(0), library = new Uint8Array(0), install = null)
{
    if(install) check_install_kernel(kernel, install);
    const metadata = install ? new TextEncoder().encode(JSON.stringify(install)) : null;
    if(metadata?.length > (128 << 10)) throw new Error("iPhone installation metadata exceeds its boot archive limit");
    const parts = [kernel, tree, logo, library, ...(metadata ? [metadata] : [])];
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    if(!kernel.length || !tree.length || length > (install ? NAND_BOOT_BANK_BYTES : MAX_BYTES))
        throw new Error("iPhone boot images do not fit the NAND firmware partition");
    const base = install ? (install.generation - 1) % 2 * BANK_PAGES : 0;
    const header = new Uint8Array(NAND_PAGE).fill(255), hv = view(header);
    header.set(MAGIC);
    header[7] = install ? 0x33 : 0x32;
    const checksums = 8 + parts.length * 4;
    for(const [i, part] of parts.entries())
    {
        hv.setUint32(8 + i * 4, part.length, true);
        header.set(new SHA256().update(part).digest(), checksums + i * 32);
    }
    if(install)
    {
        hv.setUint32(188, install.generation, true);
        header.set(new SHA256().update(header.subarray(0, 192)).digest(), 192);
    }
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
                put(...position(base + row++), page);
                page = new Uint8Array(NAND_PAGE).fill(255);
                used = 0;
            }
        }
    }
    if(used) put(...position(base + row), page);
    // A valid header is the commit record. The other bank stays bootable
    // until all new payload pages have been written and verified on read.
    put(...position(base), header);
}

export async function read_nand_boot(read)
{
    const candidates = [], errors = [];
    for(const base of [0, BANK_PAGES])
    {
        try { candidates.push(await read_boot_bank(read, base)); }
        catch(error) { errors.push(error); }
    }
    if(!candidates.length) throw errors[0];
    candidates.sort((a, b) => (b.install?.generation || 0) - (a.install?.generation || 0));
    return candidates[0];
}

async function read_boot_bank(read, base)
{
    const header = await read(nand_offset(...position(base)), NAND_SLOT);
    if(header.length !== NAND_SLOT || !MAGIC.every((byte, i) => byte === (header[i] ^ 255)))
        throw new Error("This NAND image does not contain iPhone boot files");
    const raw = header.slice(0, 224).map(byte => byte ^ 255), hv = view(raw);
    if(![0x31, 0x32, 0x33].includes(raw[7]) || base && raw[7] !== 0x33) throw new Error("Unsupported iPhone NAND boot format");
    const modern = raw[7] === 0x33, count = modern ? 5 : raw[7] === 0x32 ? 4 : 3, checksums = 8 + count * 4;
    if(modern && !new SHA256().update(raw.subarray(0, 192)).digest().every((b, i) => b === raw[192 + i]))
        throw new Error("Corrupt iPhone NAND boot commit header");
    const sizes = Array.from({ length: count }, (_, i) => hv.getUint32(8 + i * 4, true));
    const length = sizes.reduce((sum, size) => sum + size, 0);
    if(!sizes[0] || !sizes[1] || length > (modern ? NAND_BOOT_BANK_BYTES : MAX_BYTES) || modern && (!sizes[4] || sizes[4] > (128 << 10)))
        throw new Error("Invalid iPhone NAND boot file sizes");
    const files = new Uint8Array(length);
    for(let row = 1, at = 0; at < length;)
    {
        const count = Math.min(128, ROWS_PER_CHIP - (base + row) % ROWS_PER_CHIP, Math.ceil((length - at) / NAND_DATA));
        const bytes = await read(nand_offset(...position(base + row)), count * NAND_SLOT);
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
    const [kernel, tree, logo, library, metadata] = sizes.map((size, i) => {
        const bytes = files.slice(offset, offset + size);
        offset += size;
        const digest = new SHA256().update(bytes).digest();
        if(!digest.every((byte, b) => byte === raw[checksums + i * 32 + b])) throw new Error("Corrupt iPhone NAND boot file");
        return bytes.buffer;
    });
    const result = { kernel, tree, logo: logo.byteLength ? logo : null, library: library?.byteLength ? library : null };
    if(modern)
    {
        const install = JSON.parse(new TextDecoder().decode(metadata));
        check_install_kernel(new Uint8Array(kernel), install);
        if(install.generation !== hv.getUint32(188, true)) throw new Error("iPhone boot generation differs from its installation state");
        result.install = install;
    }
    return result;
}

function check_install_kernel(kernel, state)
{
    validate_install_state(state);
    const actual = n90_kernel_hashes(kernel).map(h => [...h].map(b => b.toString(16).padStart(2, "0")).join("")).sort();
    const expected = install_hashes(state);
    if(actual.length !== expected.length || actual.some((h, i) => h !== expected[i]))
        throw new Error("iPhone kernel code trust differs from its installation state");
}
