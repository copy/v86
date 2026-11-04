// Locate OpenGLES wrappers in the local iOS 6 ARM dyld shared cache. Symbol
// and string table offsets in its Mach-O headers are cache-file offsets.
import assert from "node:assert/strict";
import { macho_parse, macho_symbols } from "../../src/apple/macho.js";

export function gl_wrappers(cache)
{
    const u32 = at => cache.readUInt32LE(at);
    assert.equal(cache.toString("ascii", 0, 15), "dyld_v1   armv7");
    const mappings = Array.from({ length: u32(20) }, (_, i) => {
        const at = u32(16) + 32 * i;
        return [0, 8, 16].map(n => Number(cache.readBigUInt64LE(at + n)));
    });
    function offset(va)
    {
        for(const [base, size, fileoff] of mappings)
            if(va >= base && va - base < size) return fileoff + va - base;
        throw new Error("unmapped cache address " + va.toString(16));
    }
    let macho;
    for(let i = 0; i < u32(28); i++)
    {
        const at = u32(24) + i * 32, name = u32(at + 24);
        if(cache.toString("ascii", name, cache.indexOf(0, name)) === "/System/Library/Frameworks/OpenGLES.framework/OpenGLES")
        {
            macho = macho_parse(cache.subarray(offset(u32(at))));
            break;
        }
    }
    assert.equal(macho?.uuid, "f2ede6b206f336de82cc38619692e762", "expected the 10B329 armv7 OpenGLES image");
    const symbols = macho_symbols(cache, macho).filter(s => s.sect === 1 && s.value).sort((a, b) => a.value - b.value);
    const functions = new Map();
    for(const symbol of symbols.filter(s => /^_gl[A-Z]/.test(s.name)))
    {
        assert.ok(symbol.desc & 8, symbol.name + " is not a Thumb entry");
        const end = symbols.find(s => s.value > symbol.value);
        assert.ok(end && end.value - symbol.value <= 256, symbol.name);
        functions.set(symbol.name.slice(1), cache.subarray(offset(symbol.value), offset(end.value)));
    }
    return functions;
}

// Decode only the TLS lookup, immediate word loads and indirect call of a
// 10B329 wrapper. A missing or ambiguous call must not select a driver slot.
export function dispatch_slot(code)
{
    let tls = -1, aligned = -1, table = -1;
    const targets = new Map(), slots = new Set();
    for(let at = 0; at + 2 <= code.length;)
    {
        const h = code.readUInt16LE(at), wide = h >= 0xE800;
        if(wide && at + 4 > code.length) break;
        const lo = wide ? code.readUInt16LE(at + 2) : 0;
        at += wide ? 4 : 2;
        if(h === 0xEE1D && (lo & 0x0FFF) === 0x0F70) tls = lo >>> 12; // TPIDRURO
        else if((h & 0xFFF0) === 0xF020 && (h & 15) === tls && (lo & 0xF0FF) === 3)
            aligned = lo >>> 8 & 15; // bic reg, tls, #3
        else if((h & 0xF800) === 0x6800 || (h & 0xFFF0) === 0xF8D0)
        {
            const base = wide ? h & 15 : h >>> 3 & 7;
            const dst = wide ? lo >>> 12 : h & 7;
            const offset = wide ? lo & 0xFFF : (h >>> 6 & 31) * 4;
            if(base === aligned && offset === 0x78) table = dst;
            else if(base === table && offset > 0x10) targets.set(dst, offset);
        }
        else if((h & 0xFF07) === 0x4700 && targets.has(h >>> 3 & 15))
            slots.add(targets.get(h >>> 3 & 15)); // bx or blx
    }
    if(slots.size !== 1) throw new Error("no unique N90 driver slot");
    return [...slots][0];
}

export function gl_slot_header(wrappers)
{
    const lines = [], slots = [];
    for(const [name, code] of wrappers)
    {
        const offset = dispatch_slot(code);
        if(offset % 4) throw new Error(name + ": unaligned driver slot");
        const slot = offset / 4;
        slots.push(slot);
        lines.push("#define N90_" + name + " " + slot);
    }
    return lines.concat("#define N90_GL_TABLE_WORDS " + (Math.max(...slots) + 1), "").join("\n");
}
