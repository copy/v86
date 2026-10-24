// An empty filesystem for an Android partition that the system expects
// formatted but whose image the SDK does not ship (the ranchu machine's
// /cache, docs/aarch32-plan.md R6.3): the ext2 layout (revision 1, 4 KiB
// blocks, 256-byte inodes, file types in directories), which Linux's ext4
// driver mounts as ext4 (fstab's type) with neither a journal nor extents;
// one block group (at most 128 MiB): the superblock, its descriptor, the
// two bitmaps, the inode table, the root directory and lost+found.

const BLOCK = 4096;
const INODE_SIZE = 256;
const INODES = 2048;
const BLOCKS_PER_GROUP = 8 * BLOCK;
const FIRST_INODE = 11;

/**
 * @param {number} size bytes (a multiple of 4 KiB, 1 to 128 MiB)
 * @param {string=} label the volume's name
 * @param {number=} time seconds since the epoch, the inodes' and the superblock's times
 * @return {!Uint8Array}
 */
export function make_empty_ext4(size, label = "", time = 0)
{
    const blocks = Math.floor(size / BLOCK);
    if(blocks < 64 || blocks > BLOCKS_PER_GROUP || size % BLOCK)
    {
        throw new Error("make_empty_ext4: " + size + " bytes: a multiple of 4 KiB from 256 KiB to 128 MiB");
    }
    const image = new Uint8Array(blocks * BLOCK);
    const view = new DataView(image.buffer);
    const table_blocks = INODES * INODE_SIZE / BLOCK;
    const GDT = 1, BLOCK_BITMAP = 2, INODE_BITMAP = 3, INODE_TABLE = 4;
    const ROOT_BLOCK = INODE_TABLE + table_blocks, LOST_BLOCK = ROOT_BLOCK + 1;
    const used_blocks = LOST_BLOCK + 1;

    // the superblock at 1024
    const sb = 1024;
    const u32 = (at, v) => view.setUint32(at, v >>> 0, true);
    const u16 = (at, v) => view.setUint16(at, v, true);
    u32(sb + 0, INODES);
    u32(sb + 4, blocks);
    u32(sb + 12, blocks - used_blocks);
    u32(sb + 16, INODES - FIRST_INODE);
    u32(sb + 20, 0);
    u32(sb + 24, 2);
    u32(sb + 28, 2);
    u32(sb + 32, BLOCKS_PER_GROUP);
    u32(sb + 36, BLOCKS_PER_GROUP);
    u32(sb + 40, INODES);
    u32(sb + 44, time);
    u32(sb + 48, time);
    u16(sb + 54, 0xFFFF);
    u16(sb + 56, 0xEF53);
    u16(sb + 58, 1);
    u16(sb + 60, 1);
    u32(sb + 64, time);
    u32(sb + 76, 1);
    u32(sb + 84, FIRST_INODE);
    u16(sb + 88, INODE_SIZE);
    // (features: FILETYPE; SPARSE_SUPER and LARGE_FILE)
    u32(sb + 96, 0x0002);
    u32(sb + 100, 0x0003);
    for(let i = 0; i < 16; i++) image[sb + 104 + i] = Math.random() * 256 | 0;
    image.set(new TextEncoder().encode(label).subarray(0, 16), sb + 120);
    u32(sb + 264, time);

    // the group's descriptor
    const gd = GDT * BLOCK;
    u32(gd + 0, BLOCK_BITMAP);
    u32(gd + 4, INODE_BITMAP);
    u32(gd + 8, INODE_TABLE);
    u16(gd + 12, blocks - used_blocks);
    u16(gd + 14, INODES - FIRST_INODE);
    u16(gd + 16, 2);

    // the bitmaps: what is used, and the bits past the group's end
    const set_bits = (base, from, to) => { for(let b = from; b < to; b++) image[base + (b >> 3)] |= 1 << (b & 7); };
    set_bits(BLOCK_BITMAP * BLOCK, 0, used_blocks);
    set_bits(BLOCK_BITMAP * BLOCK, blocks, BLOCKS_PER_GROUP);
    set_bits(INODE_BITMAP * BLOCK, 0, FIRST_INODE);
    set_bits(INODE_BITMAP * BLOCK, INODES, 8 * BLOCK);

    // the root (inode 2) and lost+found (11): directories of one block each
    const inode = (n, mode, links, block) => {
        const at = INODE_TABLE * BLOCK + (n - 1) * INODE_SIZE;
        u16(at + 0, mode);
        u32(at + 4, BLOCK);
        u32(at + 8, time);
        u32(at + 12, time);
        u32(at + 16, time);
        u16(at + 26, links);
        u32(at + 28, BLOCK / 512);
        u32(at + 40, block);
    };
    inode(2, 0x41ED, 3, ROOT_BLOCK);
    inode(FIRST_INODE, 0x41C0, 2, LOST_BLOCK);
    const entry = (at, ino, rec_len, name) => {
        const bytes = new TextEncoder().encode(name);
        u32(at, ino);
        u16(at + 4, rec_len);
        image[at + 6] = bytes.length;
        // (the file type: a directory)
        image[at + 7] = 2;
        image.set(bytes, at + 8);
    };
    const root = ROOT_BLOCK * BLOCK;
    entry(root, 2, 12, ".");
    entry(root + 12, 2, 12, "..");
    entry(root + 24, FIRST_INODE, BLOCK - 24, "lost+found");
    const lost = LOST_BLOCK * BLOCK;
    entry(lost, FIRST_INODE, 12, ".");
    entry(lost + 12, 2, BLOCK - 12, "..");
    return image;
}
