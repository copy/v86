// Physical partitions below the VSVFL/YAFTL and logical LwVM layers.
// IOFlashStorage in 10B329 reads copies of this Grdn record via boot-page
// reads. The filesystem entry must be a slice for LegacyFTL block offsets.
import { NAND_BLOCKS, NAND_BLOCK_PAGES, NAND_DATA, NAND_PAGE } from "../../src/apple/nand.js";

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
    const page = Buffer.alloc(NAND_PAGE, 255);
    const t = page.subarray(0, 1536);
    t.fill(0);
    t.write("ndrG");
    t.writeUInt32LE(9, 12);
    t.writeUInt32LE(1, 16);
    t.writeUInt32LE(0xDEADCAFE, 0x224);
    t.writeUInt16LE(fletcher16(t.subarray(0x224, 0x24E)), 0x24E);
    t.write("rAps", 0x250);
    t.writeUInt16LE(fletcher16(t.subarray(0x250, 0x35A)), 0x35A);
    t.write("sbus", 0x35C);
    t.writeUInt16LE(fletcher16(t.subarray(0x35C, 0x3FE)), 0x3FE);
    const entries = [
        ["boot", 0, 1, 0], ["plog", 1, 4, 0], ["nvrm", 5, 2, 0], ["firm", 7, 8, 0x200],
        ["fsys", 15, NAND_BLOCKS - 15, 2],
    ];
    for(let i = 0; i < 32; i++)
    {
        const [name, start, count, flags] = entries[i] || ["none", 0, 0, 0], at = 0x400 + i * 16;
        t.write(Array.from(name).reverse().join(""), at);
        t.writeUInt32LE(start, at + 4);
        t.writeUInt32LE(count, at + 8);
        t.writeUInt32LE(flags, at + 12);
    }
    return page;
}

function special_page(name, payload)
{
    const page = Buffer.alloc(NAND_PAGE, 0xFF);
    page.fill(0, 0, 56);
    page.write(name);
    page.writeUInt32LE(payload.length, 52);
    payload.copy(page, 56);
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
        page.writeUInt32LE(first, offset);
        page.writeUInt32LE(second, offset + 4);
        page[offset + 8] = 0;
        page[offset + 9] = type;
        for(let i = 0; i < 3; i++)
        {
            const at = offset + i * 4;
            page.writeUInt32LE((page.readUInt32LE(at) ^ whitening[(row + i) & 255]) >>> 0, at);
        }
    }
}

function context_page(row)
{
    const page = Buffer.alloc(NAND_PAGE, 255);
    page.fill(0, 0, 2048);
    page.writeUInt32LE(1, 0);          // increasing sequence
    page.writeUInt32LE(0xFFFFFFFE, 4); // decreasing sequence
    page.writeUInt32LE(2, 8);          // YAFTL
    page.writeUInt16LE(8, 14);         // first free page after eight copies
    for(let i = 0; i < 820; i++) page.writeUInt16LE(0xFFF0, 0x26 + i * 2);
    for(let i = 0; i < 4; i++) page.writeUInt16LE(15 + i, 0x68E + i * 2);
    page.writeUInt16LE(4000, 0x696);   // usable blocks per bank
    page.writeUInt16LE(4016, 0x698);   // first replacement block
    for(let i = 0; i < 3; i++) page.writeUInt16LE(3997 + i, 0x69A + i * 2);
    page.writeUInt32LE(0x10001, 0x6DA); // vendor mapping
    page.writeUInt32LE(2, 0x7F4);      // VSVFL context version
    let sum = 0xAABBCCDD, xor = 0xAABBCCDD;
    for(let i = 0; i < 0x7F8; i += 4)
    {
        const word = page.readUInt32LE(i);
        sum = (sum + word) >>> 0;
        xor = (xor ^ word) >>> 0;
    }
    page.writeUInt32LE(sum, 0x7F8);
    page.writeUInt32LE(xor, 0x7FC);
    spare(page, row, 0xFFFFFFFE, 0xFFFF0000, 0x80);
    return page;
}

export function write_bootstrap_pages(put)
{
    const table = physical_partitions();
    put(0, 0, 0, table);
    put(0, 0, 1, table);

    // Factory-good blocks have set bits. The six directory entries in the
    // special-page header refer to the last block of the respective chip.
    const block = NAND_BLOCKS - 1, row = block * NAND_BLOCK_PAGES;
    const bbt = special_page("DEVICEINFOBBT", Buffer.alloc(Math.ceil(NAND_BLOCKS / 8), 0xFF));
    for(let i = 6; i <= 11; i++) bbt.writeUInt32LE(block, i * 4);
    for(let bus = 0; bus < 2; bus++)
        for(let ce = 0; ce < 2; ce++) put(bus, ce, row, bbt);

    const signature = Buffer.alloc(8);
    signature.write("111C");
    signature.writeUInt32LE(0x10001, 4);
    put(0, 0, row + 1, special_page("NANDDRIVERSIGN", signature));

    for(let i = 0; i < 8; i++)
    {
        const contextRow = 15 * NAND_BLOCK_PAGES + i;
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
    const row = Math.floor(vpn / FTL_BLOCK_PAGES) * NAND_BLOCK_PAGES + ((vpn % FTL_BLOCK_PAGES) >>> 2);
    const page = Buffer.alloc(NAND_PAGE, 255);
    data.copy(page);
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
        const page = Buffer.alloc(NAND_PAGE, 255);
        const row = control * NAND_BLOCK_PAGES + (part >>> 2);
        if(part === 0)
        {
            page.fill(0, 0, NAND_DATA);
            page.write("CX01");
            page.writeUInt32LE(indexBlocks, 4);
            page.writeUInt32LE(totalPages, 8);
            page.writeUInt32LE(userBlock, 12);
            page.writeUInt32LE(1, 16);
            page.writeUInt32LE(indexBlock, 20);
            page.writeUInt32LE(1, 24);
            page.writeUInt32LE(volume?.userCounts.size ?? 1, 36);
            page.writeUInt32LE(volume?.indexCounts.size ?? 1, 40);
            page.writeUInt32LE(10, 44);
            page.writeUInt16LE(Math.ceil(blocks * pagesPerBlock / entriesPerPage), 0x5C);
            page.writeUInt16LE(pagesPerBlock - userPages, 0x5E);
            page.writeUInt16LE(entriesPerPage, 0x60);
            page.writeUInt16LE(userPages, 0x64);
            page[0x94] = 99;
        }
        else if(part === 1 && volume) volume.userTOC.copy(page);
        else if(part === 2 && volume) volume.indexTOC.copy(page);
        else if(part === 4 && volume) volume.directory.copy(page);
        else if(part === 5)
        {
            page.fill(2, 0, 19);
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
            for(const [block, count] of counts) page.writeUInt16LE(count, block * 2);
        }
        spare(page, row, 0, 1, 0x20);
        put(part & 1, (part >>> 1) & 1, row, page);
    }
}
