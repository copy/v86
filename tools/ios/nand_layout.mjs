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
    for(const offset of [NAND_DATA, NAND_DATA + 12])
    {
        page.writeUInt32LE(0xFFFFFFFE, offset);
        page.writeUInt16LE(0, offset + 4);
        page[offset + 8] = 0;
        page[offset + 9] = 0x80;       // VFL metadata
        for(let i = 0; i < 3; i++)
        {
            const at = offset + i * 4;
            page.writeUInt32LE((page.readUInt32LE(at) ^ whitening[(row + i) & 255]) >>> 0, at);
        }
    }
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
