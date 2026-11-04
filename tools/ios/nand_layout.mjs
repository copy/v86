// Physical partitions below the VSVFL/YAFTL and logical LwVM layers.
// IOFlashStorage in 10B329 reads copies of this Grdn record via boot-page
// reads. The filesystem entry must be a slice for LegacyFTL block offsets.
import { NAND_BLOCKS, NAND_BLOCK_PAGES, NAND_PAGE } from "../../src/apple/nand.js";

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
}
