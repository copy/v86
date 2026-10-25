// erofs (fs/erofs/erofs_fs.h), little-endian: reading flat inodes and
// directories of 4 KiB images, and adding or replacing files as
// uncompressed data after the image (docs/android-images-plan.md I1)

import { u16, u32, u64, put16, put32, put64, latin1, bytes_of, concat, compare, crc32c } from "./bytes.js";

const EROFS_SUPER_OFFSET = 1024, EROFS_MAGIC = 0xE0F5E1E2;
const B = 4096;
const EROFS_FT_REG_FILE = 1, EROFS_FT_DIR = 2;

/**
 * An inode of a 4 KiB erofs image
 * @param {!Uint8Array} image
 * @param {number} nid
 */
export function erofs_inode(image, nid)
{
    const sb = EROFS_SUPER_OFFSET;
    if(u32(image, sb) !== EROFS_MAGIC || image[sb + 12] !== 12) throw new Error("erofs: not a 4 KiB erofs image");
    const at = u32(image, sb + 40) * B + nid * 32, extended = u16(image, at) & 1, xattr_count = u16(image, at + 2);
    return { at, extended, layout: u16(image, at) >> 1 & 7, mode: u16(image, at + 4),
        size: extended ? u64(image, at + 8) : u32(image, at + 8),
        block: u32(image, at + 16), xattrs: at + (extended ? 64 : 32), xattr_size: xattr_count ? 12 + 4 * (xattr_count - 1) : 0 };
}

/**
 * The root directory's inode
 * @param {!Uint8Array} image
 */
export function erofs_root(image)
{
    return erofs_inode(image, u16(image, EROFS_SUPER_OFFSET + 14));
}

/**
 * An uncompressed (flat) inode's data, its last block inline or not
 * @param {!Uint8Array} image
 * @param {!Object} inode
 * @return {!Uint8Array}
 */
export function erofs_data(image, inode)
{
    if(inode.layout !== 0 && inode.layout !== 2) throw new Error("erofs: not a flat inode");
    const inline = inode.layout === 2 ? inode.size % B : 0, blocks = inode.size - inline;
    return concat([image.subarray(inode.block * B, inode.block * B + blocks),
        image.subarray(inode.xattrs + inode.xattr_size, inode.xattrs + inode.xattr_size + inline)]);
}

/**
 * Where offset into a flat inode's data is in the image
 * @param {!Object} inode
 * @param {number} offset
 * @return {number}
 */
function erofs_data_at(inode, offset)
{
    const blocks = inode.size - (inode.layout === 2 ? inode.size % B : 0);
    return offset < blocks ? inode.block * B + offset : inode.xattrs + inode.xattr_size + offset - blocks;
}

/**
 * A flat directory's entries (at: where each entry is in the image)
 * @param {!Uint8Array} image
 * @param {!Object} inode
 * @return {!Array<{nid: number, type: number, name: string, at: number}>}
 */
export function erofs_entries(image, inode)
{
    const data = erofs_data(image, inode), entries = [];
    for(let base = 0; base < data.length; base += B)
    {
        const length = Math.min(B, data.length - base), count = u16(data, base + 8) / 12;
        for(let i = 0; i < count; i++)
        {
            const end = base + (i + 1 < count ? u16(data, base + (i + 1) * 12 + 8) : length);
            entries.push({ nid: u64(data, base + i * 12), type: data[base + i * 12 + 10],
                name: latin1(data, base + u16(data, base + i * 12 + 8), end).replace(/\0.*$/s, ""), at: erofs_data_at(inode, base + i * 12) });
        }
    }
    return entries;
}

/**
 * Every path under a flat directory (the root by default), depth first,
 * with its inode
 * @param {!Uint8Array} image
 * @param {Object=} inode
 * @param {string=} prefix
 * @return {!Array<{path: string, type: number, inode: !Object}>}
 */
export function erofs_list(image, inode = erofs_root(image), prefix = "")
{
    const out = [];
    for(const e of erofs_entries(image, inode))
    {
        if(e.name === "." || e.name === "..") continue;
        const child = erofs_inode(image, e.nid);
        out.push({ path: prefix + e.name, type: e.type, inode: child });
        if(e.type === EROFS_FT_DIR) out.push(...erofs_list(image, child, prefix + e.name + "/"));
    }
    return out;
}

/**
 * The inode at path, through flat directories
 * @param {!Uint8Array} image
 * @param {string} file_path
 */
export function erofs_lookup(image, file_path)
{
    let inode = erofs_root(image);
    for(const name of file_path.split("/"))
    {
        const entry = erofs_entries(image, inode).find(e => e.name === name);
        if(!entry) return null;
        inode = erofs_inode(image, entry.nid);
    }
    return inode;
}

/** the superblock's checksum, when its feature flag asks for one */
function erofs_super_checksum(out)
{
    const sb = EROFS_SUPER_OFFSET;
    if(u32(out, sb + 8) & 1)
    {
        put32(out, sb + 4, 0);
        put32(out, sb + 4, crc32c(0xFFFFFFFF, out.subarray(sb, B)));
    }
}

/**
 * image (mkfs.erofs's) with a file at file_path, its directories new under
 * the root: the new inodes, directories and the file's data (uncompressed)
 * in blocks after the image's; the root's entries move into a block of
 * their own. labels: the SELinux label of the directories and of the file
 * @param {!Uint8Array} image
 * @param {string} file_path
 * @param {!Uint8Array} data
 * @param {{dir: string, file: string}} labels
 * @return {!Uint8Array}
 */
export function erofs_add_file(image, file_path, data, labels)
{
    const sb = EROFS_SUPER_OFFSET;
    const blocks = u32(image, sb + 36), meta = u32(image, sb + 40) * B;
    const root_nid = u16(image, sb + 14), inos = u64(image, sb + 16);
    const root = erofs_inode(image, root_nid);
    const entries = erofs_entries(image, root);
    const names = file_path.split("/");
    if(entries.some(e => e.name === names[0])) throw new Error(`erofs: /${names[0]} exists`);
    // (the name filter of the root's xattrs, with security.selinux as ours)
    if(!root.xattr_size) throw new Error("erofs: the root has no xattrs");
    const filter = u32(image, root.xattrs);
    const xattrs = label =>
    {
        const entry = concat([new Uint8Array([7, 6, label.length & 0xFF, label.length >> 8]), bytes_of("selinux" + label)]);
        const body = new Uint8Array(12 + Math.ceil(entry.length / 4) * 4);
        put32(body, 0, filter);
        body.set(entry, 12);
        return body;
    };
    const dirent_block = list =>
    {
        list.sort((a, b) => compare(bytes_of(a.name), bytes_of(b.name)));
        const block = new Uint8Array(B);
        let name_at = list.length * 12;
        list.forEach((e, i) =>
        {
            put64(block, i * 12, e.nid);
            put16(block, i * 12 + 8, name_at);
            block[i * 12 + 10] = e.type;
            if(name_at + e.name.length > B) throw new Error("erofs: a directory beyond one block");
            block.set(bytes_of(e.name), name_at);
            name_at += e.name.length;
        });
        return { block, size: name_at };
    };
    // the layout after the image: one block of inodes, the directories' blocks, the data
    const new_dirs = names.length - 1;
    const inode_block = blocks, dir_block = blocks + 1, data_block = dir_block + 1 + new_dirs;
    const total = data_block + Math.ceil(data.length / B);
    const out = new Uint8Array(total * B);
    out.set(image.subarray(0, blocks * B));
    const nids = [];
    let at = inode_block * B;
    for(let i = 0; i < names.length; i++)
    {
        nids.push((at - meta) / 32);
        at += Math.ceil((32 + xattrs(labels[i + 1 === names.length ? "file" : "dir"]).length) / 32) * 32;
    }
    if(at > dir_block * B) throw new Error("erofs: the inodes beyond one block");
    const write_inode = (index, mode, nlink, size, block, label) =>
    {
        const i = (nids[index] * 32) + meta, x = xattrs(label);
        put16(out, i, 0); // compact, flat plain
        put16(out, i + 2, (x.length - 12) / 4 + 1);
        put16(out, i + 4, mode);
        put16(out, i + 6, nlink);
        put32(out, i + 8, size);
        put32(out, i + 16, block);
        put32(out, i + 20, inos + 1 + index);
        out.set(x, i + 32);
    };
    for(let d = 0; d < new_dirs; d++)
    {
        const parent = d ? nids[d - 1] : root_nid;
        const child = { nid: nids[d + 1], type: d + 1 < new_dirs ? EROFS_FT_DIR : EROFS_FT_REG_FILE, name: names[d + 1] };
        const { block, size } = dirent_block([{ nid: nids[d], type: EROFS_FT_DIR, name: "." }, { nid: parent, type: EROFS_FT_DIR, name: ".." }, child]);
        out.set(block, (dir_block + 1 + d) * B);
        write_inode(d, 0o40755, d + 1 < new_dirs ? 3 : 2, size, dir_block + 1 + d, labels.dir);
    }
    write_inode(new_dirs, 0o100644, 1, data.length, data_block, labels.file);
    out.set(data, data_block * B);
    // the root: its entries and the new directory in a block of its own
    const { block, size } = dirent_block([...entries, { nid: nids[0], type: EROFS_FT_DIR, name: names[0] }]);
    out.set(block, dir_block * B);
    put16(out, root.at, u16(out, root.at) & ~0xE);
    if(root.extended)
    {
        put64(out, root.at + 8, size);
        put32(out, root.at + 44, u32(out, root.at + 44) + 1);
    }
    else
    {
        put32(out, root.at + 8, size);
        put16(out, root.at + 6, u16(out, root.at + 6) + 1);
    }
    put32(out, root.at + 16, dir_block);
    // the superblock: its counts and checksum
    put64(out, sb + 16, inos + names.length);
    put32(out, sb + 36, total);
    erofs_super_checksum(out);
    return out;
}

/**
 * image with files (path -> data) replaced: each file a new inode (the
 * old one's fields and xattrs, its layout flat plain, no inode across a
 * block) and its data uncompressed, in blocks after the image's; the
 * directory entry points at the new inode, the old inode and blocks stay
 * unused
 * @param {!Uint8Array} image
 * @param {!Iterable<!Array>} files [path, data]
 * @return {!Uint8Array}
 */
export function erofs_replace_files(image, files)
{
    const sb = EROFS_SUPER_OFFSET;
    const blocks = u32(image, sb + 36), meta = u32(image, sb + 40) * B;
    const root = erofs_root(image);
    const changes = [];
    for(const [file_path, data] of files)
    {
        const names = file_path.split("/"), name = names.pop();
        const dir = names.length ? erofs_lookup(image, names.join("/")) : root;
        const entry = dir && erofs_entries(image, dir).find(e => e.name === name);
        if(!entry) throw new Error(`erofs: no /${file_path}`);
        const inode = erofs_inode(image, entry.nid);
        if((inode.mode & 0o170000) !== 0o100000) throw new Error(`erofs: /${file_path} is not a regular file`);
        changes.push({ entry, inode, data, head: (inode.extended ? 64 : 32) + inode.xattr_size, at: 0, block: 0 });
    }
    let end = blocks * B;
    for(const c of changes)
    {
        const size = Math.ceil(c.head / 32) * 32;
        if(end % B + size > B) end = Math.ceil(end / B) * B;
        c.at = end;
        end += size;
    }
    let block = Math.ceil(end / B);
    for(const c of changes)
    {
        c.block = block;
        block += Math.ceil(c.data.length / B);
    }
    const out = new Uint8Array(block * B);
    out.set(image.subarray(0, blocks * B));
    for(const c of changes)
    {
        out.set(image.subarray(c.inode.at, c.inode.at + c.head), c.at);
        put16(out, c.at, u16(out, c.at) & ~0xE);
        if(c.inode.extended) put64(out, c.at + 8, c.data.length);
        else put32(out, c.at + 8, c.data.length);
        put32(out, c.at + 16, c.block);
        out.set(c.data, c.block * B);
        put64(out, c.entry.at, (c.at - meta) / 32);
    }
    put32(out, sb + 36, block);
    erofs_super_checksum(out);
    return out;
}
