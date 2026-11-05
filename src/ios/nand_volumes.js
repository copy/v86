// Build the logical volumes and YAFTL translation pages for the N90.
// Inputs are raw HFS+/HFSX volumes (not the encrypted IPSW container).
import { from_hex } from "./crypto.js";
import { HFSPlus } from "./hfsplus.js";
import { crc32 } from "../android/bytes.js";
import { NAND_DATA } from "../apple/nand_geometry.js";
import { FTL_BLOCK_PAGES, FTL_ENTRIES, FTL_USER_PAGES, FIRST_INDEX_BLOCK, CONTROL_BLOCK,
    MEDIA_SIZE, write_virtual_page, write_ftl_pages } from "./nand_layout.js";

const CHUNK = 2 ** Math.ceil(Math.log2(MEDIA_SIZE / 1024));
const CHUNKS = Math.floor(MEDIA_SIZE / CHUNK);
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

async function volume_geometry(read)
{
    const volume = await new HFSPlus(read).open_header(), block = volume.block_size, size = block * volume.total_blocks;
    if(block < 512 || (block & (block - 1)) || !Number.isSafeInteger(size) ||
        !size) throw new Error("invalid HFS volume geometry");
    return volume;
}

export function data_capacity(systemSize)
{
    return (CHUNKS - 9 - Math.ceil(systemSize / CHUNK)) * CHUNK;
}

function lwvm_header(dataStart)
{
    const h = new Uint8Array(NAND_DATA);
    h.set(from_hex("6a9088cf8afd630ae351e24887e0b98b"));
    h.set(from_hex("4e39304c77564d000000000000000001"), 16);
    view(h).setBigUint64(32, BigInt(MEDIA_SIZE), true);
    view(h).setUint32(40, 2, true);
    const partitions = [[1, dataStart, "System"], [dataStart, CHUNKS - 8, "Data"]];
    for(const [n, [begin, end, name]] of partitions.entries())
    {
        const at = 512 + n * 128;
        h.set(from_hex("48465300000011aaaa1100306543ecac"), at);
        h.set(h.subarray(16, 32), at + 16);
        h[at + 31] = n + 2;
        view(h).setBigUint64(at + 32, BigInt(begin * CHUNK), true);
        view(h).setBigUint64(at + 40, BigInt(end * CHUNK), true);
        for(let i = 0; i < name.length; i++) view(h).setUint16(at + 56 + 2 * i, name.charCodeAt(i), true);
    }
    for(let i = 0; i < 1024; i++)
    {
        let tag = i >= CHUNKS ? 0xF3FF : 0xF111;
        if(!i) tag = 0xF000;
        else if(i < dataStart) tag = i - 1;
        else if(i < CHUNKS - 8) tag = 0x1000 + i - dataStart;
        view(h).setUint16(2048 + i * 2, tag, true);
    }
    view(h).setUint32(44, crc32(h.subarray(0, 4096)), true);
    return h;
}

export async function write_volumes(put, system, data, progress = () => {}, cleanData = false)
{
    const [sys, varVolume] = await Promise.all([volume_geometry(system), volume_geometry(data)]);
    const sizes = [sys.block_size * sys.total_blocks, varVolume.block_size * varVolume.total_blocks];
    const dataStart = 1 + Math.ceil(sizes[0] / CHUNK);
    const allocation = await varVolume.allocation_bitmap();
    if(dataStart >= CHUNKS - 8 || sizes[1] > data_capacity(sizes[0]))
        throw new Error("HFS volumes do not fit N90 NAND");
    const indices = new Map(), directory = new Uint8Array(NAND_DATA).fill(255);
    function stream(first, limit, type)
    {
        let block = first, used = 0, toc = new Uint8Array(NAND_DATA).fill(255);
        const counts = new Map();
        const close = () => write_virtual_page(put, block * FTL_BLOCK_PAGES + FTL_USER_PAGES, toc, 0xFFFFFFFF, block + 1, type | 8);
        return {
            append(lpn, page) {
                if(used === FTL_USER_PAGES)
                {
                    close();
                    block++;
                    used = 0;
                    toc = new Uint8Array(NAND_DATA).fill(255);
                }
                if(block >= limit) throw new Error("YAFTL block pool exhausted");
                const vpn = block * FTL_BLOCK_PAGES + used;
                write_virtual_page(put, vpn, page, lpn, block + 1, type);
                view(toc).setUint32(used * 4, lpn, true);
                counts.set(block, ++used);
                return vpn;
            },
            // The final block remains open. Its TOC lives in the checkpoint until sealed.
            finish() { return { block, toc, counts, sequence: block + 1 }; },
        };
    }
    const user = stream(22, FIRST_INDEX_BLOCK, 0x10);
    function map(lpn, bytes)
    {
        const key = Math.floor(lpn / FTL_ENTRIES);
        if(!indices.has(key)) indices.set(key, new Uint8Array(NAND_DATA).fill(255));
        view(indices.get(key)).setUint32((lpn % FTL_ENTRIES) * 4, user.append(lpn, bytes), true);
    }
    map(0, lwvm_header(dataStart));
    let done = 0;
    for(const [read, size, start] of [[system, sizes[0], 1], [data, sizes[1], dataStart]])
    {
        const page = new Uint8Array(NAND_DATA);
        for(let at = 0; at < size; at += NAND_DATA)
        {
            const length = Math.min(NAND_DATA, size - at);
            done += length;
            if(at % (NAND_DATA * 1024) === 0 || done === sizes[0] + sizes[1]) progress(done, sizes[0] + sizes[1]);
            let free = false;
            if(read === data && allocation)
            {
                const first = Math.floor(at / varVolume.block_size);
                const end = Math.ceil((at + length) / varVolume.block_size);
                let b = first;
                while(b < end && !(allocation[b >>> 3] & (0x80 >>> (b & 7)))) b++;
                free = b === end;
            }
            // Fresh generated data volumes only write allocated blocks.
            if(free && cleanData) continue;
            const bytes = await read(at, length);
            if(bytes.length !== length) throw new Error("short HFS volume read");
            if(length < NAND_DATA) page.fill(0);
            page.set(bytes);
            // 10B329 can leave the caller's buffer untouched for an unmapped
            // YAFTL page. Preserve all bytes of the restore volume and allocated
            // data blocks, including zero-filled file data and HFS metadata.
            if(free && page.every(byte => byte === 0)) continue;
            map((start * CHUNK + at) / NAND_DATA, page);
        }
    }
    const index = stream(FIRST_INDEX_BLOCK, CONTROL_BLOCK, 4);
    for(const [key, page] of indices) view(directory).setUint32(key * 4, index.append(key, page), true);
    const users = user.finish(), indexes = index.finish();
    write_ftl_pages(put, { userBlock: users.block, indexBlock: indexes.block, userTOC: users.toc,
        indexTOC: indexes.toc, userCounts: users.counts, indexCounts: indexes.counts, directory,
        userSequence: users.sequence, indexSequence: indexes.sequence, sequence: Math.max(users.sequence, indexes.sequence) + 1 });
}
