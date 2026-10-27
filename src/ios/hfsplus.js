// HFS+ and HFSX volumes, read-only (docs/iphone4-plan.md S0; Apple TN1150):
// the root filesystem and the ramdisks. A volume header at 1024, files as
// forks of up to eight extents (more in the extents overflow B-tree), the
// catalog B-tree keyed by (parent ID, name), extended attributes in the
// attributes B-tree (decmpfs compression lives there). Names are never
// compared: a directory's records are found by descending the catalog on
// the parent ID alone (its records sort together, the thread first) and
// read in order, so case folding (HFS+) and binary order (HFSX) both work.
// Reads go through read(offset, length), which returns bytes or a promise.

import { latin1 } from "../android/bytes.js";
import { inflate_zlib } from "./udif.js";

const be16 = (b, at) => b[at] << 8 | b[at + 1];
const be32 = (b, at) => (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]) >>> 0;
const be64 = (b, at) => be32(b, at) * 0x100000000 + be32(b, at + 4);

const FOLDER = 1, FILE = 2, FOLDER_THREAD = 3, FILE_THREAD = 4;
const ROOT_ID = 2, EXTENTS_ID = 3, CATALOG_ID = 4, ATTRIBUTES_ID = 8;
const LEAF = -1, INDEX = 0, HEADER = 1;
// (seconds from 1904 to 1970)
const EPOCH = 2082844800;

/** @param {!Uint8Array} b @param {number} at @return {string} an HFSUniStr255 */
function unistr(b, at)
{
    const n = be16(b, at);
    let s = "";
    for(let i = 0; i < n; i++) s += String.fromCharCode(be16(b, at + 2 + 2 * i));
    return s;
}

/** @param {!Uint8Array} b @param {number} at @return {{size: number, extents: !Array<{start: number, count: number}>}} */
function fork(b, at)
{
    const extents = [];
    for(let i = 0; i < 8; i++)
    {
        const count = be32(b, at + 16 + 8 * i + 4);
        if(count) extents.push({ start: be32(b, at + 16 + 8 * i), count });
    }
    return { size: be64(b, at), blocks: be32(b, at + 12), extents };
}

/**
 * @constructor
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 */
export function HFSPlus(read)
{
    this.read = read;
    this.header = null;
}

/** Reads the volume header and the B-trees' headers */
HFSPlus.prototype.open = async function()
{
    const h = await this.read(1024, 512);
    const signature = latin1(h, 0, 2);
    if(signature !== "H+" && signature !== "HX") throw new Error(`HFS+: no volume header (${JSON.stringify(signature)})`);
    this.case_sensitive = signature === "HX";
    this.block_size = be32(h, 0x28);
    this.total_blocks = be32(h, 0x2C);
    this.free_blocks = be32(h, 0x30);
    this.header = h;
    this.forks = { [EXTENTS_ID]: fork(h, 0xC0), [CATALOG_ID]: fork(h, 0x110), [ATTRIBUTES_ID]: fork(h, 0x160) };
    this.extents = await this.btree(EXTENTS_ID);
    this.catalog = await this.btree(CATALOG_ID);
    this.attributes = this.forks[ATTRIBUTES_ID].size ? await this.btree(ATTRIBUTES_ID) : null;
    return this;
};

/**
 * A fork's bytes [start, start + length)
 * @param {number} file_id
 * @param {{size: number, extents: !Array<{start: number, count: number}>}} f
 * @param {number} start
 * @param {number} length
 * @param {number=} fork_type 0 data, 0xFF resource
 * @return {!Promise<!Uint8Array>}
 */
HFSPlus.prototype.read_fork = async function(file_id, f, start, length, fork_type = 0)
{
    length = Math.max(0, Math.min(length, f.size - start));
    const out = new Uint8Array(length);
    let extents = f.extents, covered = extents.reduce((n, e) => n + e.count, 0);
    if(covered * this.block_size < f.size && file_id !== EXTENTS_ID)
    {
        extents = extents.concat(await this.overflow_extents(file_id, fork_type, covered));
    }
    let logical = 0;
    for(const e of extents)
    {
        const bytes = e.count * this.block_size, lo = Math.max(start, logical), hi = Math.min(start + length, logical + bytes);
        if(lo < hi)
        {
            const data = await this.read(e.start * this.block_size + (lo - logical), hi - lo);
            out.set(data, lo - start);
        }
        logical += bytes;
        if(logical >= start + length) break;
    }
    return out;
};

/**
 * The extents of a fork beyond its first eight
 * @param {number} file_id
 * @param {number} fork_type
 * @param {number} from_block
 * @return {!Promise<!Array<{start: number, count: number}>>}
 */
HFSPlus.prototype.overflow_extents = async function(file_id, fork_type, from_block)
{
    const found = [];
    // (keys: length, fork type, pad, file ID, start block; records: eight extents)
    await this.walk(this.extents, key => Math.sign(be32(key, 4) - file_id) || Math.sign(key[2] - fork_type), (key, record) =>
    {
        if(be32(key, 4) !== file_id || key[2] !== fork_type) return false;
        if(be32(key, 8) >= from_block)
        {
            for(let i = 0; i < 8; i++)
            {
                const count = be32(record, 8 * i + 4);
                if(count) found.push({ start: be32(record, 8 * i), count });
            }
        }
        return true;
    });
    return found;
};

/**
 * A B-tree's header
 * @param {number} file_id
 */
HFSPlus.prototype.btree = async function(file_id)
{
    const f = this.forks[file_id];
    const first = await this.read_fork(file_id, f, 0, 512);
    const h = first.subarray(14);
    const tree = { file_id, fork: f, node_size: be16(h, 18), root: be32(h, 2), first_leaf: be32(h, 10), key_compare: h[37] };
    tree.cache = new Map();
    return tree;
};

/**
 * A node's records as [key, data] (index nodes: data is the child's number)
 * @param {Object} tree
 * @param {number} n
 * @return {!Promise<{kind: number, next: number, records: !Array<{key: !Uint8Array, data: !Uint8Array}>}>}
 */
HFSPlus.prototype.node = async function(tree, n)
{
    if(tree.cache.has(n)) return tree.cache.get(n);
    const b = await this.read_fork(tree.file_id, tree.fork, n * tree.node_size, tree.node_size);
    const kind = b[8] << 24 >> 24, count = be16(b, 10);
    const records = [];
    for(let i = 0; i < count; i++)
    {
        const start = be16(b, tree.node_size - 2 * (i + 1)), end = be16(b, tree.node_size - 2 * (i + 2));
        const key_length = be16(b, start);
        // (keys are padded to an even length in index nodes and always in the catalog's)
        const key = b.subarray(start, start + 2 + key_length);
        const data_at = start + 2 + key_length + (key_length & 1);
        records.push({ key, data: b.subarray(data_at, i + 1 < count ? end : end || tree.node_size) });
    }
    const node = { kind, next: be32(b, 0), records };
    if(tree.cache.size > 4096) tree.cache.clear();
    tree.cache.set(n, node);
    return node;
};

/**
 * Visits leaf records in order from the first whose key compares >= 0 to
 * the target (compare(key) < 0: the key sorts before it); visit returns
 * false to stop
 * @param {Object} tree
 * @param {function(!Uint8Array): number} compare
 * @param {function(!Uint8Array, !Uint8Array): boolean} visit
 */
HFSPlus.prototype.walk = async function(tree, compare, visit)
{
    if(!tree.root) return;
    let n = tree.root;
    for(;;)
    {
        const node = await this.node(tree, n);
        if(node.kind === LEAF) break;
        if(node.kind !== INDEX) throw new Error(`HFS+: node ${n} of kind ${node.kind} in the index`);
        // (the last child whose first key sorts before the target: equal keys may continue in its left sibling)
        let child = be32(node.records[0].data, 0);
        for(const r of node.records)
        {
            if(compare(r.key) < 0) child = be32(r.data, 0);
            else break;
        }
        n = child;
    }
    for(; n;)
    {
        const node = await this.node(tree, n);
        for(const r of node.records)
        {
            if(compare(r.key) < 0) continue;
            if(!visit(r.key, r.data)) return;
        }
        n = node.next;
    }
};

/**
 * A directory's entries
 * @param {number} parent_id
 * @return {!Promise<!Array<Object>>}
 */
HFSPlus.prototype.list = async function(parent_id)
{
    const entries = [];
    await this.walk(this.catalog, key => Math.sign(be32(key, 2) - parent_id) || (be16(key, 6) ? 1 : 0), (key, data) =>
    {
        if(be32(key, 2) !== parent_id) return false;
        const type = be16(data, 0);
        if(type === FOLDER || type === FILE) entries.push(this.record(unistr(key, 6), data));
        return true;
    });
    return entries;
};

/**
 * @param {string} name
 * @param {!Uint8Array} d a folder or file record
 * @return {Object}
 */
HFSPlus.prototype.record = function(name, d)
{
    const type = be16(d, 0);
    const entry = {
        name, type: type === FOLDER ? "directory" : "file", id: be32(d, 8),
        created: be32(d, 12) - EPOCH, modified: be32(d, 16) - EPOCH,
        uid: be32(d, 32), gid: be32(d, 36), flags: d[41] | d[40] << 8, mode: be16(d, 42), special: be32(d, 44),
    };
    if(type === FILE)
    {
        entry.file_type = latin1(d, 48, 52);
        entry.creator = latin1(d, 52, 56);
        entry.data = fork(d, 88);
        entry.resource = fork(d, 168);
        entry.size = entry.data.size;
        if((entry.mode & 0xF000) === 0xA000 || entry.file_type === "slnk" && entry.creator === "rhap") entry.type = "symlink";
        else if(entry.file_type === "hlnk" && entry.creator === "hfs+") entry.type = "hardlink";
        // (UF_COMPRESSED: the contents are in the com.apple.decmpfs attribute)
        entry.compressed = !!(entry.flags & 0x20);
    }
    else
    {
        entry.valence = be32(d, 4);
    }
    return entry;
};

/**
 * The entry at an absolute path (symbolic links in the path not followed)
 * @param {string} path
 * @return {!Promise<?Object>}
 */
HFSPlus.prototype.lookup = async function(path)
{
    let entry = { name: "/", type: "directory", id: ROOT_ID };
    for(const part of path.split("/").filter(Boolean))
    {
        if(entry.type !== "directory") return null;
        const children = await this.list(entry.id);
        entry = children.find(c => c.name === part) ||
            (!this.case_sensitive && children.find(c => c.name.toLowerCase() === part.toLowerCase())) || null;
        if(!entry) return null;
    }
    return entry;
};

/**
 * An attribute's value
 * @param {number} file_id
 * @param {string} name
 * @return {!Promise<?Uint8Array>}
 */
HFSPlus.prototype.attribute = async function(file_id, name)
{
    if(!this.attributes) return null;
    let found = null;
    await this.walk(this.attributes, key => Math.sign(be32(key, 4) - file_id), (key, data) =>
    {
        if(be32(key, 4) !== file_id) return false;
        let n = "";
        for(let i = 0, length = be16(key, 12); i < length; i++) n += String.fromCharCode(be16(key, 14 + 2 * i));
        if(n !== name) return true;
        if(be32(data, 0) !== 0x10) throw new Error(`HFS+: attribute ${name} of file ${file_id} is not inline`);
        found = data.slice(16, 16 + be32(data, 12));
        return false;
    });
    return found;
};

/**
 * A file's contents (hard links resolved, decmpfs zlib decompressed;
 * a symbolic link's target)
 * @param {Object} entry list's or lookup's
 * @return {!Promise<!Uint8Array>}
 */
HFSPlus.prototype.contents = async function(entry)
{
    if(entry.type === "directory") throw new Error(`HFS+: ${entry.name} is a directory`);
    if(entry.type === "hardlink")
    {
        const node = await this.lookup(`/\u0000\u0000\u0000\u0000HFS+ Private Data/iNode${entry.special}`);
        if(!node) throw new Error(`HFS+: hard link ${entry.name} to a missing iNode${entry.special}`);
        return this.contents(node);
    }
    if(entry.compressed)
    {
        const header = await this.attribute(entry.id, "com.apple.decmpfs");
        if(!header || latin1(header, 0, 4) !== "fpmc") throw new Error(`HFS+: ${entry.name} is compressed without a decmpfs header`);
        const type = header[4] | header[5] << 8, size = (header[8] | header[9] << 8 | header[10] << 16 | header[11] << 24) >>> 0;
        if(type === 3)
        {
            // (inline: 0xFF then the bytes as they are, or zlib)
            const body = header.subarray(16);
            return (body[0] & 0x0F) === 0x0F ? body.slice(1, 1 + size) : (await inflate_zlib(body)).subarray(0, size);
        }
        if(type === 4)
        {
            // (in the resource fork: a resource header, then a table of zlib blocks of 64 KiB each)
            const rsrc = await this.read_fork(entry.id, entry.resource, 0, entry.resource.size, 0xFF);
            const data_at = be32(rsrc, 0);
            const table = data_at + 4, count = rsrc[table] | rsrc[table + 1] << 8 | rsrc[table + 2] << 16 | rsrc[table + 3] << 24;
            const out = new Uint8Array(size);
            for(let i = 0, o = 0; i < count; i++)
            {
                const at = table + 4 + 8 * i;
                const offset = (rsrc[at] | rsrc[at + 1] << 8 | rsrc[at + 2] << 16 | rsrc[at + 3] << 24) >>> 0;
                const length = (rsrc[at + 4] | rsrc[at + 5] << 8 | rsrc[at + 6] << 16 | rsrc[at + 7] << 24) >>> 0;
                const block = rsrc.subarray(table + offset, table + offset + length);
                const plain = (block[0] & 0x0F) === 0x0F ? block.subarray(1) : await inflate_zlib(block);
                out.set(plain.subarray(0, size - o), o);
                o += plain.length;
            }
            return out;
        }
        throw new Error(`HFS+: ${entry.name} uses decmpfs type ${type}`);
    }
    return this.read_fork(entry.id, entry.data, 0, entry.data.size);
};

/**
 * Every entry under a directory, depth first: visit(path, entry)
 * @param {string} path
 * @param {function(string, Object): (Promise|undefined)} visit
 */
HFSPlus.prototype.walk_tree = async function(path, visit)
{
    const start = await this.lookup(path);
    if(!start) throw new Error(`HFS+: no ${path}`);
    const recurse = async (prefix, id) =>
    {
        for(const child of await this.list(id))
        {
            const p = prefix + "/" + child.name;
            await visit(p, child);
            if(child.type === "directory") await recurse(p, child.id);
        }
    };
    if(start.type === "directory") await recurse(path.replace(/\/$/, ""), start.id);
    else await visit(path, start);
};
