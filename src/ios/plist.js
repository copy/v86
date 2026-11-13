// XML property lists as Apple's firmware carries them (docs/iphone4-plan.md
// S0): BuildManifest.plist and Restore.plist in the IPSW, a DMG's resource
// fork, the kernelcache's prelink info. The kernel's dialect (OSUnserializeXML)
// shares repeated values: ID="n" on the first, IDREF="n" on the empty
// element that repeats it; its integers may be hexadecimal and 64 bits
// wide. Values: objects (dict), arrays, strings, numbers (bigint beyond
// 2^53), booleans, Uint8Array (data), Date.

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

/** @param {string} text @return {string} */
function unescape(text)
{
    return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name) =>
        name[0] === "#" ? String.fromCodePoint(name[1] === "x" ? parseInt(name.slice(2), 16) : +name.slice(1)) :
        ENTITIES[name] ?? whole);
}

/** @param {string} text @return {!Uint8Array} */
function base64(text)
{
    const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array(clean.length * 3 >> 2);
    const value = c => c >= 97 ? c - 71 : c >= 65 ? c - 65 : c >= 48 ? c + 4 : c === 43 ? 62 : 63;
    let bits = 0, n = 0, o = 0;
    for(let i = 0; i < clean.length; i++)
    {
        bits = bits << 6 | value(clean.charCodeAt(i));
        n += 6;
        if(n >= 8) { n -= 8; out[o++] = bits >> n & 0xFF; }
    }
    return out.subarray(0, o);
}

/** @param {string} text @return {number|bigint} */
function integer(text)
{
    text = text.trim();
    const negative = text[0] === "-";
    const digits = negative ? text.slice(1) : text;
    const big = BigInt(digits.startsWith("0x") || digits.startsWith("0X") ? digits : digits.replace(/^0+(?=\d)/, ""));
    const value = negative ? -big : big;
    return value >= -(2n ** 53n) && value <= 2n ** 53n ? Number(value) : value;
}

/**
 * @param {string|!Uint8Array} source
 * @return {*} the plist's top-level value
 */
export function plist_parse(source)
{
    if(source instanceof Uint8Array && new TextDecoder().decode(source.subarray(0, 8)) === "bplist00")
        return binary_plist_parse(source);
    const text = typeof source === "string" ? source : new TextDecoder().decode(source);
    // (the elements and the text between them; comments, the prolog and the doctype skipped)
    const tokens = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "")
        .split(/(<[^>]+>)/);
    let at = 0;
    const ids = new Map();
    const next_tag = () =>
    {
        while(at < tokens.length && !tokens[at].startsWith("<"))
        {
            if(tokens[at].trim()) throw new Error(`plist: text outside an element: ${tokens[at].trim().slice(0, 40)}`);
            at++;
        }
        if(at >= tokens.length) throw new Error("plist: cut short");
        return tokens[at++];
    };
    const attributes = tag =>
    {
        const out = {};
        for(const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
        return out;
    };
    const value = () =>
    {
        const tag = next_tag();
        const m = /^<\s*([A-Za-z]+)([^>]*?)(\/?)\s*>$/.exec(tag);
        if(!m) throw new Error(`plist: unexpected ${tag}`);
        const [, name, rest, empty] = m;
        const attrs = attributes(rest);
        if(attrs.IDREF !== undefined)
        {
            if(!ids.has(attrs.IDREF)) throw new Error(`plist: IDREF ${attrs.IDREF} before its ID`);
            return ids.get(attrs.IDREF);
        }
        let result;
        if(name === "plist")
        {
            result = value();
            if(next_tag() !== "</plist>") throw new Error("plist: more than one top-level value");
            return result;
        }
        const body = () =>
        {
            if(empty) return "";
            let content = "";
            while(at < tokens.length && tokens[at] !== `</${name}>`)
            {
                if(tokens[at].startsWith("<")) throw new Error(`plist: ${tokens[at]} inside <${name}>`);
                content += tokens[at++];
            }
            if(at >= tokens.length) throw new Error(`plist: <${name}> not closed`);
            at++;
            return unescape(content);
        };
        switch(name)
        {
            case "dict":
            {
                result = {};
                if(attrs.ID !== undefined) ids.set(attrs.ID, result);
                if(empty) return result;
                for(;;)
                {
                    const key = next_tag();
                    if(key === "</dict>") break;
                    if(key !== "<key>") throw new Error(`plist: ${key} where a key goes`);
                    let k = "";
                    while(tokens[at] !== "</key>") { if(at >= tokens.length) throw new Error("plist: <key> not closed"); k += tokens[at++]; }
                    at++;
                    Object.defineProperty(result, unescape(k), { value: value(), enumerable: true, configurable: true, writable: true });
                }
                return result;
            }
            case "array":
            {
                result = [];
                if(attrs.ID !== undefined) ids.set(attrs.ID, result);
                if(empty) return result;
                for(;;)
                {
                    let peek = at;
                    while(peek < tokens.length && !tokens[peek].startsWith("<")) peek++;
                    if(tokens[peek] === "</array>")
                    {
                        next_tag();
                        break;
                    }
                    result.push(value());
                }
                return result;
            }
            case "string": result = body(); break;
            case "integer": result = integer(body()); break;
            case "real": result = parseFloat(body()); break;
            case "true": result = true; if(!empty) body(); break;
            case "false": result = false; if(!empty) body(); break;
            case "data": result = base64(body()); break;
            case "date": result = new Date(body().trim()); break;
            default: throw new Error(`plist: unknown element <${name}>`);
        }
        if(attrs.ID !== undefined) ids.set(attrs.ID, result);
        return result;
    };
    return value();
}

// Binary property lists: all offsets and references are checked before use.
// UID values are represented as integers; cycles are not valid app metadata.
export function binary_plist_parse(bytes)
{
    const fail = message => { throw new Error("binary plist: " + message); };
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 32;
    if(end < 8 || new TextDecoder().decode(bytes.subarray(0, 8)) !== "bplist00") fail("invalid header");
    const uint = (at, size, limit = bytes.length) => {
        if(![1, 2, 4, 8].includes(size) || at < 0 || at + size > limit) fail("invalid integer bounds");
        let n = 0n;
        for(let i = 0; i < size; i++) n = n * 256n + BigInt(bytes[at + i]);
        return n;
    };
    const number = n => { if(n > BigInt(Number.MAX_SAFE_INTEGER)) fail("integer exceeds safe offset range"); return Number(n); };
    const offsetSize = bytes[end + 6], refSize = bytes[end + 7];
    const count = number(uint(end + 8, 8)), top = number(uint(end + 16, 8)), table = number(uint(end + 24, 8));
    if(!count || count > 1000000 || top >= count || ![1, 2, 4, 8].includes(refSize) ||
        ![1, 2, 4, 8].includes(offsetSize) || table < 8 || table + count * offsetSize > end) fail("invalid trailer");
    const offsets = Array.from({ length: count }, (_, i) => number(uint(table + i * offsetSize, offsetSize, end)));
    if(offsets.some(at => at < 8 || at >= table)) fail("object outside object table");
    const cache = new Map(), active = new Set();
    const parse = (id, depth = 0) => {
        if(id < 0 || id >= count || depth > 128 || active.has(id)) fail("invalid reference or cyclic object");
        if(cache.has(id)) return cache.get(id);
        active.add(id);
        let at = offsets[id], marker = bytes[at++], kind = marker >>> 4, length = marker & 15, result;
        if(kind >= 4 && kind !== 8 && length === 15)
        {
            const integer = bytes[at++];
            if(integer >>> 4 !== 1 || (integer & 15) > 3) fail("invalid object length");
            const size = 2 ** (integer & 15);
            length = number(uint(at, size, table)); at += size;
        }
        const range = size => { if(!Number.isSafeInteger(size) || at + size > table) fail("truncated object"); };
        const reference = index => number(uint(at + index * refSize, refSize, table));
        switch(kind)
        {
            case 0:
                if(marker === 0) result = null;
                else if(marker === 8 || marker === 9) result = marker === 9;
                else fail("unsupported simple value");
                break;
            case 1:
            case 8:
            {
                const size = kind === 8 ? length + 1 : 2 ** length;
                if(kind === 8 ? size > 16 : ![1, 2, 4, 8, 16].includes(size)) fail("unsupported integer size");
                range(size);
                let n = 0n;
                for(let i = 0; i < size; i++) n = n * 256n + BigInt(bytes[at + i]);
                if(kind === 1 && size >= 8 && bytes[at] & 128) n -= 1n << BigInt(size * 8);
                result = n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
                break;
            }
            case 2:
                range(2 ** length);
                if(length !== 2 && length !== 3) fail("invalid real");
                result = length === 2 ? v.getFloat32(at) : v.getFloat64(at); break;
            case 3:
                if(marker !== 0x33) fail("invalid date");
                range(8); result = new Date((v.getFloat64(at) + 978307200) * 1000); break;
            case 4: range(length); result = bytes.slice(at, at + length); break;
            case 5: range(length); result = new TextDecoder("ascii").decode(bytes.subarray(at, at + length)); break;
            case 6: range(length * 2); result = new TextDecoder("utf-16be").decode(bytes.subarray(at, at + length * 2)); break;
            case 10:
            case 11:
            case 12:
                range(length * refSize);
                result = Array.from({ length }, (_, i) => parse(reference(i), depth + 1)); break;
            case 13:
                range(length * refSize * 2); result = {};
                for(let i = 0; i < length; i++)
                {
                    const key = parse(reference(i), depth + 1);
                    if(typeof key !== "string" || Object.hasOwn(result, key)) fail("invalid or duplicate dictionary key");
                    Object.defineProperty(result, key, { value: parse(reference(i + length), depth + 1), enumerable: true, writable: true, configurable: true });
                }
                break;
            default: fail("unsupported object type " + kind);
        }
        active.delete(id); cache.set(id, result); return result;
    };
    return parse(top);
}

export function plist_encode(value)
{
    const escape = text => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
    const write = (item, depth = 0) => {
        if(depth > 128) throw new Error("plist: value is too deeply nested");
        if(typeof item === "string") return "<string>" + escape(item) + "</string>";
        if(typeof item === "boolean") return item ? "<true/>" : "<false/>";
        if(typeof item === "bigint" || typeof item === "number" && Number.isInteger(item)) return "<integer>" + item + "</integer>";
        if(typeof item === "number" && Number.isFinite(item)) return "<real>" + item + "</real>";
        if(item instanceof Date) return "<date>" + item.toISOString() + "</date>";
        if(item instanceof Uint8Array)
        {
            let text = "";
            for(let i = 0; i < item.length; i += 8192) text += String.fromCharCode(...item.subarray(i, i + 8192));
            return "<data>" + btoa(text) + "</data>";
        }
        if(Array.isArray(item)) return "<array>" + item.map(x => write(x, depth + 1)).join("") + "</array>";
        if(item && typeof item === "object") return "<dict>" + Object.entries(item).map(([k, v]) =>
            "<key>" + escape(k) + "</key>" + write(v, depth + 1)).join("") + "</dict>";
        throw new Error("plist: unsupported value");
    };
    return new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">' + write(value) + "</plist>\n");
}
