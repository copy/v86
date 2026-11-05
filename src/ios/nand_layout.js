// Physical partitions below the VSVFL/YAFTL and logical LwVM layers.
// IOFlashStorage in 10B329 reads copies of this Grdn record via boot-page
// reads. The filesystem entry must be a slice for LegacyFTL block offsets.
import { effaceable_unit } from "./provision.js";
import { NAND_BLOCKS, NAND_BLOCK_PAGES, NAND_DATA, NAND_PAGE } from "../apple/nand_geometry.js";

const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = (bytes, value, at = 0) => {
    for(let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
};
const VFL_CONTEXT_BLOCK = 15, VFL_CONTEXT_COPIES = 4;
const RAW_BLOCKS = VFL_CONTEXT_BLOCK + VFL_CONTEXT_COPIES;
const REPLACEMENT_START = 4016;

function fletcher16(bytes)
{
    let a = 255, b = 255;
    for(const value of bytes)
    {
        a += value;
        a = (a & 255) + (a >>> 8);
        b += a;
        b = (b & 255) + (b >>> 8);
    }
    return b << 8 | a;
}

export function physical_partitions()
{
    const page = new Uint8Array(NAND_PAGE).fill(255);
    const t = page.subarray(0, 1536);
    t.fill(0);
    ascii(t, "ndrG");
    view(t).setUint32(12, 9, true);
    view(t).setUint32(16, 1, true);
    view(t).setUint32(0x224, 0xDEADCAFE, true);
    view(t).setUint16(0x24E, fletcher16(t.subarray(0x224, 0x24E)), true);
    ascii(t, "rAps", 0x250);
    view(t).setUint16(0x35A, fletcher16(t.subarray(0x250, 0x35A)), true);
    ascii(t, "sbus", 0x35C);
    view(t).setUint16(0x3FE, fletcher16(t.subarray(0x35C, 0x3FE)), true);
    const entries = [
        ["boot", 0, 1, 0], ["plog", 1, 4, 2], ["nvrm", 5, 2, 0], ["firm", 7, 7, 0x200],
        ["fsys", VFL_CONTEXT_BLOCK, NAND_BLOCKS - VFL_CONTEXT_BLOCK, 2], ["fbbt", 14, 1, 1],
    ];
    for(let i = 0; i < 32; i++)
    {
        const [name, start, count, flags] = entries[i] || ["none", 0, 0, 0], at = 0x400 + i * 16;
        ascii(t, Array.from(name).reverse().join(""), at);
        view(t).setUint32(at + 4, start, true);
        view(t).setUint32(at + 8, count, true);
        view(t).setUint32(at + 12, flags, true);
    }
    return page;
}

// AppleNANDLegacyFTL serves readRegion(1) from DEVICEUNIQUEINFO. Its
// payload starts with an SCfg header followed by inline 20-byte entries.
function factory_config()
{
    const cfg = new Uint8Array(24 + 20);
    ascii(cfg, "gfCS");
    view(cfg).setUint32(4, cfg.length, true);  // used bytes
    view(cfg).setUint32(8, cfg.length, true);  // capacity
    view(cfg).setUint32(12, 1, true);
    view(cfg).setUint32(20, 1, true);
    ascii(cfg, "mNrS", 24); // SrNm
    ascii(cfg, "V86N90SIM001", 28);
    return cfg;
}

function special_page(name, payload)
{
    const page = new Uint8Array(NAND_PAGE).fill(255);
    page.fill(0, 0, 56);
    ascii(page, name);
    view(page).setUint32(52, payload.length, true);
    page.set(payload, 56);
    return page;
}

// N90 firmware XORs each three-word spare record with a sequence indexed
// by physical row. The table is shared by the two logical pages in a row.
const whitening = new Uint32Array(256);
let seed = 0x50F4546A;
for(let i = 0; i < whitening.length; i++)
{
    for(let n = 0; n < 763; n++) seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    whitening[i] = seed;
}

function spare(page, row, first, second, type)
{
    for(const offset of [NAND_DATA, NAND_DATA + 12])
    {
        view(page).setUint32(offset, first, true);
        view(page).setUint32(offset + 4, second, true);
        page[offset + 8] = 0;
        page[offset + 9] = type;
        for(let i = 0; i < 3; i++)
        {
            const at = offset + i * 4;
            view(page).setUint32(at, (view(page).getUint32(at, true) ^ whitening[(row + i) & 255]) >>> 0, true);
        }
    }
}

function context_page(row)
{
    const page = new Uint8Array(NAND_PAGE).fill(255);
    page.fill(0, 0, 2048);
    view(page).setUint32(0, 1, true);          // increasing sequence
    view(page).setUint32(4, 0xFFFFFFFE, true); // decreasing sequence
    view(page).setUint32(8, 2, true);          // YAFTL
    view(page).setUint16(14, 8, true);         // first free page after eight copies
    for(let i = 0; i < 820; i++) view(page).setUint16(0x26 + i * 2, 0xFFF0, true);
    // VSVFL's vendor mapping starts at block zero. Its context remaps
    // the raw boot area and context ring into the replacement pool, so
    // YAFTL recovery can erase these virtual blocks without touching them.
    page[0x16] = RAW_BLOCKS;           // replacements allocated in the sole bank
    for(let i = 0; i < RAW_BLOCKS; i++) view(page).setUint16(0x26 + i * 2, i, true);
    for(let i = 0; i < VFL_CONTEXT_COPIES; i++) view(page).setUint16(0x68E + i * 2, VFL_CONTEXT_BLOCK + i, true);
    view(page).setUint16(0x696, FTL_BLOCKS, true);
    view(page).setUint16(0x698, REPLACEMENT_START, true);
    for(let i = 0; i < 3; i++) view(page).setUint16(0x69A + i * 2, CONTROL_BLOCK + i, true);
    view(page).setUint32(0x6DA, 0x10001, true); // vendor mapping
    view(page).setUint32(0x7F4, 2, true);      // VSVFL context version
    let sum = 0xAABBCCDD, xor = 0xAABBCCDD;
    for(let i = 0; i < 0x7F8; i += 4)
    {
        const word = view(page).getUint32(i, true);
        sum = (sum + word) >>> 0;
        xor = (xor ^ word) >>> 0;
    }
    view(page).setUint32(0x7F8, sum, true);
    view(page).setUint32(0x7FC, xor, true);
    spare(page, row, 0xFFFFFFFE, 0xFFFF0000, 0x80);
    return page;
}

export function write_bootstrap_pages(put)
{
    // Each Effaceable group starts its units at boot page sixteen.
    const locker = new Uint8Array(NAND_PAGE).fill(255);
    locker.set(effaceable_unit());
    for(let block = 1; block <= 4; block++) put(0, 0, block * NAND_BLOCK_PAGES + 16, locker);
    const table = physical_partitions();
    put(0, 0, 0, table);
    put(0, 0, 1, table);

    // Factory-good blocks have set bits. The six directory entries in the
    // special-page header refer to the last block of the respective chip.
    const block = NAND_BLOCKS - 1, row = block * NAND_BLOCK_PAGES;
    const bbt = special_page("DEVICEINFOBBT", new Uint8Array(Math.ceil(NAND_BLOCKS / 8)).fill(255));
    for(let i = 6; i <= 11; i++) view(bbt).setUint32(i * 4, block, true);
    for(let bus = 0; bus < 2; bus++)
        for(let ce = 0; ce < 2; ce++) put(bus, ce, row, bbt);

    const signature = new Uint8Array(8);
    ascii(signature, "111C");
    view(signature).setUint32(4, 0x10001, true);
    put(0, 0, row + 1, special_page("NANDDRIVERSIGN", signature));

    put(0, 0, row + 2, special_page("DEVICEUNIQUEINFO", factory_config()));

    for(let i = 0; i < 8; i++)
    {
        const contextRow = VFL_CONTEXT_BLOCK * NAND_BLOCK_PAGES + i;
        const context = context_page(contextRow);
        for(let bus = 0; bus < 2; bus++)
            for(let ce = 0; ce < 2; ce++) put(bus, ce, contextRow, context);
    }
}

// A clean YAFTL checkpoint. Virtual pages stripe across both controllers
// before advancing to the next chip select and then to the next row.
export const FTL_BLOCKS = 4000, FTL_BLOCK_PAGES = 4 * NAND_BLOCK_PAGES;
export const FTL_ENTRIES = NAND_DATA / 4;
export const FTL_USER_PAGES = FTL_BLOCK_PAGES - Math.ceil(FTL_BLOCK_PAGES / FTL_ENTRIES);
const indexBlocks = 3 * Math.ceil((FTL_BLOCKS - 8) / FTL_ENTRIES);
const totalPages = (FTL_BLOCKS - 8) * FTL_USER_PAGES - indexBlocks * FTL_BLOCK_PAGES;
// 10B329 divides by 100 before applying the 99 percent user capacity.
export const MEDIA_SIZE = Math.floor(totalPages / 100) * 99 * NAND_DATA;
export const CONTROL_BLOCK = FTL_BLOCKS - 3;
export const FIRST_INDEX_BLOCK = CONTROL_BLOCK - indexBlocks;

export function write_virtual_page(put, vpn, data, lpn, usn, type)
{
    const block = Math.floor(vpn / FTL_BLOCK_PAGES);
    const physical = block < RAW_BLOCKS ? REPLACEMENT_START + block : block;
    const row = physical * NAND_BLOCK_PAGES + ((vpn % FTL_BLOCK_PAGES) >>> 2);
    const page = new Uint8Array(NAND_PAGE).fill(255);
    page.set(data);
    spare(page, row, lpn, usn, type);
    put(vpn & 1, (vpn >>> 1) & 1, row, page);
}

export function write_ftl_pages(put, volume)
{
    const blocks = FTL_BLOCKS, pagesPerBlock = FTL_BLOCK_PAGES, entriesPerPage = FTL_ENTRIES;
    const userPages = FTL_USER_PAGES, control = CONTROL_BLOCK;
    const userBlock = volume?.userBlock ?? 22, indexBlock = volume?.indexBlock ?? 23;
    // Header, two block TOCs, statistics, index-page directory, block
    // states, read counts, two erase-count pages and two valid-page counts.
    for(let part = 0; part < 11; part++)
    {
        const page = new Uint8Array(NAND_PAGE).fill(255);
        const row = control * NAND_BLOCK_PAGES + (part >>> 2);
        if(part === 0)
        {
            page.fill(0, 0, NAND_DATA);
            ascii(page, "CX01");
            view(page).setUint32(4, indexBlocks, true);
            view(page).setUint32(8, totalPages, true);
            view(page).setUint32(12, userBlock, true);
            view(page).setUint32(16, volume?.userSequence ?? 1, true);
            view(page).setUint32(20, indexBlock, true);
            view(page).setUint32(24, volume?.indexSequence ?? 1, true);
            view(page).setUint32(36, volume?.userCounts.size ?? 1, true);
            view(page).setUint32(40, volume?.indexCounts.size ?? 1, true);
            view(page).setUint32(44, volume?.sequence ?? 10, true);
            view(page).setUint16(0x5C, Math.ceil(blocks * pagesPerBlock / entriesPerPage), true);
            view(page).setUint16(0x5E, pagesPerBlock - userPages, true);
            view(page).setUint16(0x60, entriesPerPage, true);
            view(page).setUint16(0x64, userPages, true);
            view(page).setUint16(0x66, volume?.userCounts.get(userBlock) ?? 0, true);
            view(page).setUint16(0x68, volume?.indexCounts.get(indexBlock) ?? 0, true);
            page[0x94] = 99;
        }
        else if(part === 1 && volume) page.set(volume.userTOC);
        else if(part === 2 && volume) page.set(volume.indexTOC);
        else if(part === 4 && volume) page.set(volume.directory);
        else if(part === 5)
        {
            page.fill(2, 0, RAW_BLOCKS);
            page[userBlock] = 1;
            page[indexBlock] = 0x40;
            if(volume)
            {
                for(const block of volume.userCounts.keys()) page[block] = 1;
                for(const block of volume.indexCounts.keys()) page[block] = 0x40;
            }
            page[control] = 0x10;
            page[control + 1] = page[control + 2] = 2;
        }
        else if(part === 3 || part >= 6) page.fill(0, 0, NAND_DATA);
        if(volume && (part === 9 || part === 10))
        {
            const counts = part === 9 ? volume.indexCounts : volume.userCounts;
            for(const [block, count] of counts) view(page).setUint16(block * 2, count, true);
        }
        spare(page, row, 0, 1, 0x20);
        put(part & 1, (part >>> 1) & 1, row, page);
    }
}
