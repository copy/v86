// Build the logical volumes and YAFTL translation pages for the N90.
// Inputs are raw HFS+/HFSX volumes (not the encrypted IPSW container).
import fs from "node:fs";
import { crc32 } from "../../src/android/bytes.js";
import { NAND_DATA } from "../../src/apple/nand.js";
import { FTL_BLOCK_PAGES, FTL_ENTRIES, FTL_USER_PAGES, FIRST_INDEX_BLOCK, CONTROL_BLOCK,
    MEDIA_SIZE, write_virtual_page, write_ftl_pages } from "./nand_layout.mjs";

const CHUNK = 2 ** Math.ceil(Math.log2(MEDIA_SIZE / 1024));
const CHUNKS = Math.floor(MEDIA_SIZE / CHUNK);
const empty = Buffer.alloc(NAND_DATA);

function volume_size(fd)
{
    const header = Buffer.alloc(512);
    if(fs.readSync(fd, header, 0, header.length, 1024) !== header.length ||
        !["H+", "HX"].includes(header.toString("ascii", 0, 2))) throw new Error("expected a raw HFS+ or HFSX volume");
    const blockSize = header.readUInt32BE(40), size = blockSize * header.readUInt32BE(44);
    if(blockSize < 512 || (blockSize & (blockSize - 1)) || !Number.isSafeInteger(size) ||
        !size || size > fs.fstatSync(fd).size) throw new Error("invalid HFS volume geometry");
    return size;
}

function lwvm_header(dataStart)
{
    const h = Buffer.alloc(NAND_DATA);
    Buffer.from("6a9088cf8afd630ae351e24887e0b98b", "hex").copy(h);
    Buffer.from("4e39304c77564d000000000000000001", "hex").copy(h, 16);
    h.writeBigUInt64LE(BigInt(MEDIA_SIZE), 32);
    h.writeUInt32LE(2, 40);
    const partitions = [[1, dataStart, "System"], [dataStart, CHUNKS - 8, "Data"]];
    for(const [n, [begin, end, name]] of partitions.entries())
    {
        const at = 512 + n * 128;
        Buffer.from("48465300000011aaaa1100306543ecac", "hex").copy(h, at);
        h.copy(h, at + 16, 16, 32);
        h[at + 31] = n + 2;
        h.writeBigUInt64LE(BigInt(begin * CHUNK), at + 32);
        h.writeBigUInt64LE(BigInt(end * CHUNK), at + 40);
        h.write(name, at + 56, "utf16le");
    }
    for(let i = 0; i < 1024; i++)
    {
        let tag = i >= CHUNKS ? 0xF3FF : 0xF111;
        if(!i) tag = 0xF000;
        else if(i < dataStart) tag = i - 1;
        else if(i < CHUNKS - 8) tag = 0x1000 + i - dataStart;
        h.writeUInt16LE(tag, 2048 + i * 2);
    }
    h.writeUInt32LE(crc32(h.subarray(0, 4096)), 44);
    return h;
}

export function write_volumes(put, system, data)
{
    const sizes = [volume_size(system), volume_size(data)], dataStart = 1 + Math.ceil(sizes[0] / CHUNK);
    if(dataStart >= CHUNKS - 8 || sizes[1] > (CHUNKS - 8 - dataStart) * CHUNK)
        throw new Error("HFS volumes do not fit N90 NAND");
    const indices = new Map(), directory = Buffer.alloc(NAND_DATA, 255);
    function stream(first, limit, type)
    {
        let block = first, used = 0, toc = Buffer.alloc(NAND_DATA, 255);
        const counts = new Map();
        const close = () => write_virtual_page(put, block * FTL_BLOCK_PAGES + FTL_USER_PAGES, toc, 0xFFFFFFFF, 1, type);
        return {
            append(lpn, page) {
                if(used === FTL_USER_PAGES)
                {
                    close();
                    block++;
                    used = 0;
                    toc = Buffer.alloc(NAND_DATA, 255);
                }
                if(block >= limit) throw new Error("YAFTL block pool exhausted");
                const vpn = block * FTL_BLOCK_PAGES + used;
                write_virtual_page(put, vpn, page, lpn, 1, type);
                toc.writeUInt32LE(lpn, used * 4);
                counts.set(block, ++used);
                return vpn;
            },
            finish() { close(); return { block, toc, counts }; },
        };
    }
    const user = stream(22, FIRST_INDEX_BLOCK, 0x10);
    function map(lpn, bytes)
    {
        const key = Math.floor(lpn / FTL_ENTRIES);
        if(!indices.has(key)) indices.set(key, Buffer.alloc(NAND_DATA, 255));
        indices.get(key).writeUInt32LE(user.append(lpn, bytes), (lpn % FTL_ENTRIES) * 4);
    }
    map(0, lwvm_header(dataStart));
    for(const [fd, size, start] of [[system, sizes[0], 1], [data, sizes[1], dataStart]])
    {
        const page = Buffer.alloc(NAND_DATA);
        for(let at = 0; at < size; at += NAND_DATA)
        {
            const length = Math.min(NAND_DATA, size - at);
            if(length < NAND_DATA) page.fill(0);
            if(fs.readSync(fd, page, 0, length, at) !== length) throw new Error("short HFS volume read");
            if(!page.equals(empty)) map((start * CHUNK + at) / NAND_DATA, page);
        }
    }
    const index = stream(FIRST_INDEX_BLOCK, CONTROL_BLOCK, 4);
    for(const [key, page] of indices) directory.writeUInt32LE(index.append(key, page), key * 4);
    const users = user.finish(), indexes = index.finish();
    write_ftl_pages(put, { userBlock: users.block, indexBlock: indexes.block, userTOC: users.toc,
        indexTOC: indexes.toc, userCounts: users.counts, indexCounts: indexes.counts, directory });
}
