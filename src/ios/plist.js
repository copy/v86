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
                    result[unescape(k)] = value();
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
