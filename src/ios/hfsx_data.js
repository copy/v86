// A clean HFSX data volume for a new N90. The volume is written sparsely;
// the caller supplies a random-access sink that starts with zero bytes.
// On-disk structures follow Apple Technical Note TN1150.
const BLOCK = 4096, CATALOG_NODE = 8192, EPOCH = 2082844800;
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = (bytes, offset, value) => {
    for(let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
};
const utf16 = (v, offset, value) => {
    v.setUint16(offset, value.length);
    for(let i = 0; i < value.length; i++) v.setUint16(offset + 2 + 2 * i, value.charCodeAt(i));
};

function fork(v, at, size, start, count, clump = 0)
{
    if(!count) return;
    v.setBigUint64(at, BigInt(size));
    v.setUint32(at + 8, clump);
    v.setUint32(at + 12, count);
    v.setUint32(at + 16, start);
    v.setUint32(at + 20, count);
}

export function catalog_key(parent, name)
{
    const bytes = new Uint8Array(8 + 2 * name.length), v = view(bytes);
    v.setUint16(0, bytes.length - 2);
    v.setUint32(2, parent);
    utf16(v, 6, name);
    return bytes;
}

export function catalog_thread(parent, name, directory)
{
    const bytes = new Uint8Array(10 + 2 * name.length), v = view(bytes);
    v.setUint16(0, directory ? 3 : 4);
    v.setUint32(4, parent);
    utf16(v, 8, name);
    return bytes;
}

function node(size, records, kind, height, previous = 0, next = 0)
{
    const bytes = new Uint8Array(size), v = view(bytes);
    v.setUint32(0, next);
    v.setUint32(4, previous);
    v.setInt8(8, kind);
    v.setUint8(9, height);
    v.setUint16(10, records.length);
    let pos = 14;
    for(const [i, record] of records.entries())
    {
        v.setUint16(size - 2 * (i + 1), pos);
        for(const bytesPart of record)
        {
            bytes.set(bytesPart, pos);
            pos += bytesPart.length;
        }
    }
    v.setUint16(size - 2 * (records.length + 1), pos);
    return bytes;
}

function set_bit(bits, bit) { bits[bit >>> 3] |= 128 >>> (bit & 7); }

function tree(records, size, maxKey, compare, attributes)
{
    const nodes = [null];
    let height = 0, leafEnd = 0, items = records;
    while(items.length)
    {
        height++;
        const groups = [];
        let used = 16, group = [];
        for(const item of items)
        {
            const need = 2 + item[0].length + item[1].length;
            if(used + need > size)
            {
                groups.push(group);
                used = 16;
                group = [];
            }
            group.push(item);
            used += need;
        }
        groups.push(group);
        const start = nodes.length;
        if(height === 1) leafEnd = groups.length;
        items = groups.map((group, i) => {
            const n = start + i;
            nodes.push(node(size, group, height === 1 ? -1 : 0, height,
                i ? n - 1 : 0, i + 1 < groups.length ? n + 1 : 0));
            const child = new Uint8Array(4);
            view(child).setUint32(0, n);
            return [group[0][0], child];
        });
        if(groups.length === 1) break;
    }
    const map = new Uint8Array(size - 256), header = new Uint8Array(106), v = view(header);
    // Leave spare nodes in each initial tree for the first guest writes.
    const total = nodes.length + 15;
    if(total > map.length * 8) throw new Error("HFSX data catalog exceeds its initial node map");
    v.setUint16(0, height);
    v.setUint32(2, nodes.length - 1);
    v.setUint32(6, records.length);
    v.setUint32(10, leafEnd ? 1 : 0);
    v.setUint32(14, leafEnd);
    v.setUint16(18, size);
    v.setUint16(20, maxKey);
    v.setUint32(22, total);
    v.setUint32(26, total - nodes.length);
    v.setUint32(32, size * 16);
    v.setUint8(37, compare);
    v.setUint32(38, attributes);
    for(let i = 0; i < nodes.length; i++) set_bit(map, i);
    nodes[0] = node(size, [[header], [new Uint8Array(128)], [map]], 1, 0);
    return { nodes, bytes: total * size, node_size: size };
}

/**
 * Copy the shipped /private/var contents, preserving POSIX metadata and
 * symlinks, and add locally produced files such as the system keybag.
 * @param {!Object} system an open HFSPlus system volume
 * @param {number} capacity data partition size in bytes
 * @param {function(number, !Uint8Array): *} write
 * @param {!Array<{path: string, bytes: !Uint8Array, dir_mode: number, mode: number, uid: (number|undefined), gid: (number|undefined)}>} files
 */
export async function write_hfsx_data(system, capacity, write, files)
{
    const blocks = capacity / BLOCK;
    if(!Number.isInteger(blocks) || blocks < 256 || blocks > 0xFFFFFFFF) throw new Error("Invalid HFSX data capacity");
    const epoch = Math.floor(Date.now() / 1000) + EPOCH;
    const root = { id: 2, parent: 1, name: "Data", type: "directory", mode: 0o40755, children: 0, folders: 0 };
    const entries = new Map([["/", root]]);
    let nextID = 16;
    function add(path, source, data = null, resource = null)
    {
        const slash = path.lastIndexOf("/"), name = path.slice(slash + 1), parent = entries.get(path.slice(0, slash) || "/");
        if(!name || name.length > 255 || name === "." || name === ".." || entries.has(path) || parent?.type !== "directory")
            throw new Error("Invalid HFSX data path: " + path);
        parent.children++;
        if(source.type === "directory") parent.folders++;
        entries.set(path, { ...source, id: nextID++, parent: parent.id, name, children: 0, folders: 0, data, resource });
    }
    const varRoot = await system.lookup("/private/var");
    if(varRoot?.type !== "directory") throw new Error("System image does not contain /private/var");
    for(const field of ["uid", "gid", "mode", "created", "modified"]) root[field] = varRoot[field];
    await system.walk_tree("/private/var", async (path, entry) => {
        const relative = path.slice("/private/var".length);
        if(entry.type === "directory") add(relative, entry);
        else if(entry.type === "file" || entry.type === "symlink")
        {
            const data = await system.contents(entry);
            const resource = entry.resource.size && !entry.compressed ?
                await system.read_fork(entry.id, entry.resource, 0, entry.resource.size, 255) : null;
            add(relative, entry, data, resource);
        }
        else throw new Error("Unsupported HFSX data entry: " + path);
    });
    // HFS uses these two catalog directories for native hard links.
    add("/\0\0\0\0HFS+ Private Data", { type: "directory", mode: 0o40000, flags: 2, invisible: true });
    add("/.HFS+ Private Directory Data\r", { type: "directory", mode: 0o41555, flags: 2, invisible: true });
    for(const file of files)
    {
        const directory = file.path.slice(0, file.path.lastIndexOf("/"));
        if(directory && !entries.has(directory))
            add(directory, { type: "directory", mode: 0o40000 | file.dir_mode, uid: file.uid, gid: file.gid });
        add(file.path, { type: "file", mode: 0o100000 | file.mode, uid: file.uid, gid: file.gid }, file.bytes);
    }

    const allocationBytes = Math.ceil(blocks / 8 / BLOCK) * BLOCK, allocation = new Uint8Array(allocationBytes);
    let cursor = 1;
    const space = size => {
        const start = cursor, count = Math.ceil(size / BLOCK);
        cursor += count;
        if(cursor >= blocks) throw new Error("HFSX data does not fit its partition");
        return { start, count };
    };
    const alloc = space(allocationBytes);
    const extents = tree([], BLOCK, 10, 0, 2), ext = space(extents.bytes);
    const attributes = tree([], CATALOG_NODE, 266, 0, 6), attr = space(attributes.bytes);
    let fileCount = 0, folderCount = 0;
    const records = [];
    for(const entry of entries.values())
    {
        const directory = entry.type === "directory";
        if(directory) folderCount += Number(entry !== root);
        else fileCount++;
        const body = new Uint8Array(directory ? 88 : 248), v = view(body);
        v.setUint16(0, directory ? 1 : 2);
        v.setUint16(2, directory ? 0x10 : 2); // folder count or file thread
        v.setUint32(4, entry.children);
        v.setUint32(8, entry.id);
        const created = entry.created ? entry.created + EPOCH : epoch, modified = entry.modified ? entry.modified + EPOCH : epoch;
        v.setUint32(12, created);
        v.setUint32(16, modified);
        v.setUint32(20, modified);
        v.setUint32(24, modified);
        v.setUint32(32, entry.uid || 0);
        v.setUint32(36, entry.gid || 0);
        v.setUint16(40, (entry.flags || 0) & ~0x20); // the new forks are uncompressed
        v.setUint16(42, entry.mode);
        if(entry !== root) v.setUint32(44, 1);
        if(directory) v.setUint32(84, entry.folders);
        if(entry.invisible) v.setUint16(56, 0x5000);
        if(!directory)
        {
            ascii(body, 48, entry.type === "symlink" ? "slnk" : entry.file_type || "");
            ascii(body, 52, entry.type === "symlink" ? "rhap" : entry.creator || "");
            for(const [at, bytes] of [[88, entry.data], [168, entry.resource]])
            {
                if(!bytes?.length) continue;
                const f = space(bytes.length);
                await write(f.start * BLOCK, bytes);
                fork(v, at, bytes.length, f.start, f.count);
            }
        }
        records.push({ parent: entry.parent, name: entry.name, parts: [catalog_key(entry.parent, entry.name), body] });
        records.push({ parent: entry.id, name: "", parts: [catalog_key(entry.id, ""), catalog_thread(entry.parent, entry.name, directory)] });
    }
    records.sort((a, b) => a.parent - b.parent || (a.name < b.name ? -1 : Number(a.name > b.name)));
    const catalog = tree(records.map(r => r.parts), CATALOG_NODE, 516, 0xBC, 6), cat = space(catalog.bytes);
    for(const [bt, f] of [[extents, ext], [attributes, attr], [catalog, cat]])
        for(const [i, bytes] of bt.nodes.entries()) await write(f.start * BLOCK + i * bt.node_size, bytes);
    for(let b = 0; b < cursor; b++) set_bit(allocation, b);
    set_bit(allocation, blocks - 1);
    await write(alloc.start * BLOCK, allocation);

    const header = new Uint8Array(512), v = view(header);
    ascii(header, 0, "HX");
    v.setUint16(2, 5);
    v.setUint32(4, 0x80000100); // unused CNIDs and clean unmount
    ascii(header, 8, "10.0");
    v.setUint32(16, epoch);
    v.setUint32(20, epoch);
    v.setUint32(28, epoch);
    v.setUint32(32, fileCount);
    v.setUint32(36, folderCount);
    v.setUint32(40, BLOCK);
    v.setUint32(44, blocks);
    v.setUint32(48, blocks - cursor - 1);
    v.setUint32(52, cursor);
    v.setUint32(56, BLOCK * 16);
    v.setUint32(60, BLOCK * 16);
    v.setUint32(64, nextID);
    v.setUint32(68, 1);
    v.setBigUint64(72, 1n); // Roman encoding bit for the initial names
    ascii(header, 104, "V86N90VD");
    fork(v, 0x70, allocationBytes, alloc.start, alloc.count);
    fork(v, 0xC0, extents.bytes, ext.start, ext.count, extents.node_size * 16);
    fork(v, 0x110, catalog.bytes, cat.start, cat.count, catalog.node_size * 16);
    fork(v, 0x160, attributes.bytes, attr.start, attr.count, attributes.node_size * 16);
    await write(1024, header);
    await write(capacity - 1024, header);
    return entries.size - 1;
}
