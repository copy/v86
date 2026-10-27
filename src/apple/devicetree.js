// Apple's flattened device tree (docs/iphone4-plan.md S0, S1): a node is
// its property count and child count (u32 each, little-endian), its
// properties (a 32-byte NUL-padded name, a u32 length, the value padded to
// 4 bytes) and its children. The length's top bit marks a placeholder that
// iBoot replaces (with a value of the same size) while it fills the tree:
// v86 does that filling itself (src/apple/boot.js).

const PLACEHOLDER = 0x80000000;

/**
 * @typedef {{name: string, value: !Uint8Array, placeholder: boolean}}
 */
export let DTProperty;

/**
 * @typedef {{properties: !Array<!DTProperty>, children: !Array<!Object>}}
 */
export let DTNode;

/**
 * @param {!Uint8Array} bytes
 * @return {!DTNode} the root
 */
export function dt_parse(bytes)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    const node = () =>
    {
        if(at + 8 > bytes.length) throw new Error("device tree: cut short");
        const property_count = view.getUint32(at, true), child_count = view.getUint32(at + 4, true);
        at += 8;
        const properties = [], children = [];
        for(let i = 0; i < property_count; i++)
        {
            if(at + 36 > bytes.length) throw new Error("device tree: a property cut short");
            const raw = bytes.subarray(at, at + 32);
            const end = raw.indexOf(0);
            const name = String.fromCharCode(...raw.subarray(0, end < 0 ? 32 : end));
            const word = view.getUint32(at + 32, true), length = word & ~PLACEHOLDER;
            if(at + 36 + length > bytes.length) throw new Error(`device tree: property ${name} cut short`);
            properties.push({ name, value: bytes.slice(at + 36, at + 36 + length), placeholder: !!(word & PLACEHOLDER) });
            at += 36 + (length + 3 & ~3);
        }
        for(let i = 0; i < child_count; i++) children.push(node());
        return { properties, children };
    };
    const root = node();
    return root;
}

/**
 * @param {!DTNode} root
 * @return {!Uint8Array}
 */
export function dt_serialize(root)
{
    const size = n => 8 + n.properties.reduce((s, p) => s + 36 + (p.value.length + 3 & ~3), 0) + n.children.reduce((s, c) => s + size(c), 0);
    const out = new Uint8Array(size(root)), view = new DataView(out.buffer);
    let at = 0;
    const write = n =>
    {
        view.setUint32(at, n.properties.length, true);
        view.setUint32(at + 4, n.children.length, true);
        at += 8;
        for(const p of n.properties)
        {
            if(p.name.length > 31) throw new Error(`device tree: property name ${p.name} is too long`);
            for(let i = 0; i < p.name.length; i++) out[at + i] = p.name.charCodeAt(i);
            view.setUint32(at + 32, (p.value.length | (p.placeholder ? PLACEHOLDER : 0)) >>> 0, true);
            out.set(p.value, at + 36);
            at += 36 + (p.value.length + 3 & ~3);
        }
        for(const c of n.children) write(c);
    };
    write(root);
    return out;
}

/** @param {!DTNode} node @param {string} name @return {?DTProperty} */
export function dt_property(node, name)
{
    return node.properties.find(p => p.name === name) || null;
}

/** @param {!DTNode} node @return {string} its name property */
export function dt_name(node)
{
    const p = dt_property(node, "name");
    return p ? dt_string(p.value) : "";
}

/** @param {!Uint8Array} value @return {string} up to the first NUL */
export function dt_string(value)
{
    const end = value.indexOf(0);
    return String.fromCharCode(...value.subarray(0, end < 0 ? value.length : end));
}

/** @param {!Uint8Array} value @return {!Array<string>} a list of NUL-terminated strings */
export function dt_strings(value)
{
    return String.fromCharCode(...value).split("\0").filter(Boolean);
}

/** @param {!Uint8Array} value @return {!Array<number>} little-endian u32 cells */
export function dt_cells(value)
{
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return Array.from({ length: value.length >> 2 }, (_, i) => view.getUint32(4 * i, true));
}

/**
 * The node at a path of names ("/arm-io/uart0"; the root is "/" or "")
 * @param {!DTNode} root
 * @param {string} path
 * @return {?DTNode}
 */
export function dt_find(root, path)
{
    let node = root;
    for(const part of path.split("/").filter(Boolean))
    {
        node = node.children.find(c => dt_name(c) === part);
        if(!node) return null;
    }
    return node;
}

/**
 * Sets (or adds) a property; placeholder cleared
 * @param {!DTNode} node
 * @param {string} name
 * @param {!Uint8Array} value
 */
export function dt_set(node, name, value)
{
    const p = dt_property(node, name);
    if(p) { p.value = value; p.placeholder = false; }
    else node.properties.push({ name, value, placeholder: false });
}

/**
 * Every node with its path, depth first: visit(path, node)
 * @param {!DTNode} root
 * @param {function(string, !DTNode)} visit
 */
export function dt_walk(root, visit)
{
    const recurse = (prefix, node) =>
    {
        visit(prefix || "/", node);
        for(const c of node.children) recurse(prefix + "/" + dt_name(c), c);
    };
    recurse("", root);
}
