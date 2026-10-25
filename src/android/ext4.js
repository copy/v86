// An empty filesystem for an Android partition that the system expects
// formatted but whose image the SDK does not ship, or ships too small (the
// ranchu machine's /cache, docs/aarch32-plan.md R6.3; API 28's userdata,
// whose userdata.img is 1 MiB that the emulator grows): the ext2 layout
// (revision 1, 4 KiB blocks, 256-byte inodes, file types in directories,
// sparse superblocks), which Linux's ext4 driver mounts as ext4 (fstab's
// type) with neither a journal nor extents. Block groups of 128 MiB, each
// with its bitmaps and inode table (and in groups 0, 1 and the powers of 3,
// 5 and 7 a copy of the superblock and the group descriptors); the root
// directory and lost+found in group 0.

const BLOCK = 4096;
const INODE_SIZE = 256;
const BLOCKS_PER_GROUP = 8 * BLOCK;
const FIRST_INODE = 11;
const DESCRIPTOR_SIZE = 32;

/**
 * Whether group `g` keeps a copy of the superblock (sparse_super)
 * @param {number} g
 */
function has_super(g)
{
    if(g <= 1) return true;
    for(const base of [3, 5, 7])
    {
        let n = base;
        while(n < g) n *= base;
        if(n === g) return true;
    }
    return false;
}

/**
 * The filesystem as the writes of its metadata (everything else zeros: a
 * new disk's blocks), so that a large one is never in memory whole
 * @param {number} size bytes (a multiple of 4 KiB, at least 256 KiB, below 16 TiB)
 * @param {string=} label the volume's name
 * @param {number=} time seconds since the epoch, the inodes' and the superblock's times
 * @return {!Array<{offset: number, bytes: !Uint8Array}>}
 */
export function ext4_writes(size, label = "", time = 0)
{
    const blocks = Math.floor(size / BLOCK);
    if(blocks < 64 || size % BLOCK || blocks >= 2 ** 32)
    {
        throw new Error("make_empty_ext4: " + size + " bytes: a multiple of 4 KiB from 256 KiB to below 16 TiB");
    }
    let groups = Math.ceil(blocks / BLOCKS_PER_GROUP);
    // (a last group too small for its metadata is left out of the filesystem)
    const inodes_per_group = Math.min(8192, Math.max(2048, Math.floor(blocks / groups / 4) & ~7));
    const table_blocks = inodes_per_group * INODE_SIZE / BLOCK;
    const gdt_blocks = Math.ceil(groups * DESCRIPTOR_SIZE / BLOCK);
    const metadata = g => (has_super(g) ? 1 + gdt_blocks : 0) + 2 + table_blocks;
    let total = blocks;
    if(groups > 1 && total - (groups - 1) * BLOCKS_PER_GROUP < metadata(groups - 1) + 16)
    {
        groups--;
        total = groups * BLOCKS_PER_GROUP;
    }
    const inodes = groups * inodes_per_group;
    const writes = [];
    const view_of = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // the groups' layout and what they use
    const layout = [];
    for(let g = 0; g < groups; g++)
    {
        const start = g * BLOCKS_PER_GROUP;
        const length = Math.min(BLOCKS_PER_GROUP, total - start);
        const first = start + (has_super(g) ? 1 + gdt_blocks : 0);
        layout.push({ start, length, block_bitmap: first, inode_bitmap: first + 1, inode_table: first + 2, used: metadata(g) });
    }
    // (group 0: the root directory's block and lost+found's after its table)
    const ROOT_BLOCK = layout[0].inode_table + table_blocks, LOST_BLOCK = ROOT_BLOCK + 1;
    layout[0].used += 2;
    const free_blocks = layout.reduce((n, l) => n + l.length - l.used, 0);

    // the superblock (and its copies: the same but their group number)
    const superblock = g =>
    {
        const sb = new Uint8Array(1024), view = view_of(sb);
        const u32 = (at, v) => view.setUint32(at, v >>> 0, true);
        const u16 = (at, v) => view.setUint16(at, v, true);
        u32(0, inodes);
        u32(4, total);
        u32(12, free_blocks);
        u32(16, inodes - FIRST_INODE);
        u32(20, 0);
        u32(24, 2);
        u32(28, 2);
        u32(32, BLOCKS_PER_GROUP);
        u32(36, BLOCKS_PER_GROUP);
        u32(40, inodes_per_group);
        u32(44, time);
        u32(48, time);
        u16(54, 0xFFFF);
        u16(56, 0xEF53);
        u16(58, 1);
        u16(60, 1);
        u32(64, time);
        u32(76, 1);
        u32(84, FIRST_INODE);
        u16(88, INODE_SIZE);
        u16(90, g);
        // (features: FILETYPE; SPARSE_SUPER and LARGE_FILE)
        u32(96, 0x0002);
        u32(100, 0x0003);
        // (the volume's UUID: a deterministic one from the size and time)
        let seed = (size / BLOCK ^ time ^ 0x5EED) >>> 0;
        for(let i = 0; i < 16; i++)
        {
            seed = Math.imul(seed ^ seed >>> 15, 0x2C1B3C6D) + 0x297A2D39 >>> 0;
            sb[104 + i] = seed >>> 24;
        }
        sb.set(new TextEncoder().encode(label).subarray(0, 16), 120);
        u32(264, time);
        return sb;
    };
    const descriptors = new Uint8Array(gdt_blocks * BLOCK);
    {
        const view = view_of(descriptors);
        layout.forEach((l, g) =>
        {
            const at = g * DESCRIPTOR_SIZE;
            view.setUint32(at + 0, l.block_bitmap, true);
            view.setUint32(at + 4, l.inode_bitmap, true);
            view.setUint32(at + 8, l.inode_table, true);
            view.setUint16(at + 12, l.length - l.used, true);
            view.setUint16(at + 14, g === 0 ? inodes_per_group - FIRST_INODE : inodes_per_group, true);
            view.setUint16(at + 16, g === 0 ? 2 : 0, true);
        });
    }
    layout.forEach((l, g) =>
    {
        if(has_super(g))
        {
            writes.push({ offset: g === 0 ? 1024 : l.start * BLOCK, bytes: superblock(g) });
            writes.push({ offset: (l.start + 1) * BLOCK, bytes: descriptors });
        }
        // the bitmaps: what is used, and the bits past the group's end
        const block_bitmap = new Uint8Array(BLOCK), inode_bitmap = new Uint8Array(BLOCK);
        const set_bits = (bitmap, from, to) => { for(let b = from; b < to; b++) bitmap[b >> 3] |= 1 << (b & 7); };
        set_bits(block_bitmap, 0, l.used);
        set_bits(block_bitmap, l.length, BLOCKS_PER_GROUP);
        set_bits(inode_bitmap, 0, g === 0 ? FIRST_INODE : 0);
        set_bits(inode_bitmap, inodes_per_group, 8 * BLOCK);
        writes.push({ offset: l.block_bitmap * BLOCK, bytes: block_bitmap });
        writes.push({ offset: l.inode_bitmap * BLOCK, bytes: inode_bitmap });
    });

    // the root (inode 2) and lost+found (11): directories of one block each
    const table = new Uint8Array(FIRST_INODE * INODE_SIZE), table_view = view_of(table);
    const inode = (n, mode, links, block) =>
    {
        const at = (n - 1) * INODE_SIZE;
        table_view.setUint16(at + 0, mode, true);
        table_view.setUint32(at + 4, BLOCK, true);
        table_view.setUint32(at + 8, time, true);
        table_view.setUint32(at + 12, time, true);
        table_view.setUint32(at + 16, time, true);
        table_view.setUint16(at + 26, links, true);
        table_view.setUint32(at + 28, BLOCK / 512, true);
        table_view.setUint32(at + 40, block, true);
    };
    inode(2, 0x41ED, 3, ROOT_BLOCK);
    inode(FIRST_INODE, 0x41C0, 2, LOST_BLOCK);
    writes.push({ offset: layout[0].inode_table * BLOCK, bytes: table });
    const directory = entries =>
    {
        const bytes = new Uint8Array(BLOCK), view = view_of(bytes);
        let at = 0;
        entries.forEach(([ino, name], i) =>
        {
            const encoded = new TextEncoder().encode(name);
            const rec_len = i === entries.length - 1 ? BLOCK - at : 12;
            view.setUint32(at, ino, true);
            view.setUint16(at + 4, rec_len, true);
            bytes[at + 6] = encoded.length;
            // (the file type: a directory)
            bytes[at + 7] = 2;
            bytes.set(encoded, at + 8);
            at += rec_len;
        });
        return bytes;
    };
    writes.push({ offset: ROOT_BLOCK * BLOCK, bytes: directory([[2, "."], [2, ".."], [FIRST_INODE, "lost+found"]]) });
    writes.push({ offset: LOST_BLOCK * BLOCK, bytes: directory([[FIRST_INODE, "."], [2, ".."]]) });
    return writes;
}

/**
 * The filesystem whole (a small one: it is in memory)
 * @param {number} size bytes (a multiple of 4 KiB, at least 256 KiB)
 * @param {string=} label the volume's name
 * @param {number=} time seconds since the epoch, the inodes' and the superblock's times
 * @return {!Uint8Array}
 */
export function make_empty_ext4(size, label = "", time = 0)
{
    const writes = ext4_writes(size, label, time);
    const image = new Uint8Array(size);
    for(const w of writes) image.set(w.bytes, w.offset);
    return image;
}
