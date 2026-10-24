#!/usr/bin/env node
// Generates src/graphics_adapters/virtio_gpu/gfxstream_protocol.js, gfxstream's
// Vulkan wire format (docs/gfxstream-plan.md G2), from the C that gfxstream's
// codegen made for the guest driver of the pinned build (mesa
// src/gfxstream/guest/vulkan_enc, docs/gfxstream-protocol.md):
//
// - the guest's request writers (goldfish_vk_reserved_marshaling_guest.cpp
//   reservedmarshal_*, and VkEncoder.cpp's commands up to their replies) say
//   how requests are laid out; they become decoders here (d_*)
// - the guest's reply readers (goldfish_vk_marshaling_guest.cpp unmarshal_*,
//   and the rest of VkEncoder.cpp's commands) say how replies are laid out;
//   they become encoders (e_*)
//
// The C is a parsed (statements and expressions of the few kinds it has) and
// translated statement by statement; a statement of another kind stops it.
// The guest's stream features are the ones it sets for virtio-gpu
// (ResourceTracker::setupCaps: all four), so the C's feature tests are
// constants here.
//
// With --guest <file>, it also writes the other side (requests encoded,
// replies decoded: what the driver does) for tests that play the driver.
//
// usage: tools/gfxstream_protocol_gen.mjs <vulkan_enc dir> <mesa include/vulkan dir> [out.js] [--guest guest.js]

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const argv = process.argv.slice(2);
const guest_at = argv.indexOf("--guest");
const guest_file = guest_at >= 0 ? argv.splice(guest_at, 2)[1] : null;
const [enc_dir, include_dir, out_file = "src/graphics_adapters/virtio_gpu/gfxstream_protocol.js"] = argv;
if(!enc_dir || !include_dir)
{
    console.error("usage: gfxstream_protocol_gen.mjs <vulkan_enc dir> <mesa include/vulkan dir> [out.js] [--guest guest.js]");
    process.exit(1);
}
const read = file => fs.readFileSync(file, "utf8");
if(!process.env.GFXSTREAM_GEN_TRACE) process.on("uncaughtException", e => { console.error("gfxstream_protocol_gen: " + e.message); process.exit(1); });

// the stream features of a virtio-gpu guest (goldfish_vk_private_defs.h)
const FEATURE_BITS = {
    VULKAN_STREAM_FEATURE_NULL_OPTIONAL_STRINGS_BIT: 1,
    VULKAN_STREAM_FEATURE_IGNORED_HANDLES_BIT: 2,
    VULKAN_STREAM_FEATURE_SHADER_FLOAT16_INT8_BIT: 4,
    VULKAN_STREAM_FEATURE_QUEUE_SUBMIT_WITH_COMMANDS_BIT: 8,
};
const FEATURES = 15;
const STRUCTURE_TYPE_MAX_ENUM = 0x7FFFFFFF;

// ---------------------------------------------------------------------------
// The headers: types (what a C type is on the wire) and constants

const HEADERS = [
    path.join(include_dir, "vulkan_core.h"),
    path.join(include_dir, "vulkan_android.h"),
    path.join(enc_dir, "vk_android_native_buffer_gfxstream.h"),
    path.join(enc_dir, "vulkan_gfxstream.h"),
].filter(f => fs.existsSync(f));
const header_text = HEADERS.map(read).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

const PRIMITIVES = {
    uint8_t: "u8", int8_t: "i8", uint16_t: "u16", int16_t: "i16", uint32_t: "u32", int32_t: "i32", int: "i32",
    uint64_t: "u64", int64_t: "i64", float: "f32", double: "f64", size_t: "u64", uintptr_t: "u64", char: "char", void: "void", bool: "u8",
};
/** @type {Map<string, string>} a type's name -> another type's (typedefs) or a kind: "enum", "handle", "struct", "union" */
const types = new Map();
/** @type {Map<string, Map<string, {type: string, pointer: number, array: string}>>} structs' members */
const members = new Map();
{
    for(const m of header_text.matchAll(/typedef\s+(?:unsigned\s+)?(\w+)\s+(\w+)\s*;/g))
    {
        if(m[1] !== "struct" && m[1] !== "enum" && m[1] !== "union") types.set(m[2], m[1]);
    }
    for(const m of header_text.matchAll(/typedef\s+enum\s+(\w+)\s*\{/g)) types.set(m[1], "enum");
    for(const m of header_text.matchAll(/VK_DEFINE(?:_NON_DISPATCHABLE)?_HANDLE\((\w+)\)/g)) types.set(m[1], "handle");
    for(const m of header_text.matchAll(/typedef\s+(struct|union)\s+(\w+)?\s*\{([^}]*)\}\s*(\w+)\s*;/g))
    {
        m[2] = m[4];
        types.set(m[2], m[1]);
        const list = new Map();
        for(const line of m[3].split(";"))
        {
            const d = /^\s*(?:const\s+)?(?:struct\s+)?(\w+)((?:\s*\*\s*(?:const\s*)?)*)\s*(\w+)\s*((?:\[[^\]]*\])*)\s*$/.exec(line.replace(/\/\/.*$/gm, "").trim());
            if(d) list.set(d[3], { type: d[1], pointer: (d[2].match(/\*/g) || []).length, array: d[4] });
        }
        members.set(m[2], list);
    }
    // (Android's own types, by pointer only)
    for(const name of ["AHardwareBuffer", "ANativeWindow", "buffer_handle_t"]) if(!types.has(name)) types.set(name, "struct");
}

/**
 * A C type's kind on the wire: a primitive's reader ("u32", "i32", "u64",
 * "f32", "u8", "char", "void", ...), "h" (a handle), "struct" or "union"
 * @param {string} name
 */
function kind_of(name)
{
    name = name.replace(/\bconst\b/g, "").trim();
    for(let i = 0; i < 16; i++)
    {
        if(PRIMITIVES[name]) return PRIMITIVES[name];
        const t = types.get(name);
        if(t === undefined)
        {
            if(/^PFN_/.test(name)) return "u64";
            throw new Error("unknown type " + name);
        }
        if(t === "enum") return "i32";
        if(t === "handle") return "h";
        if(t === "struct" || t === "union") return t;
        name = t;
    }
    throw new Error("typedef loop at " + name);
}
const SIZES = { u8: 1, i8: 1, char: 1, void: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8, h: 8 };

/**
 * A C type's size and alignment (LP64, as the guest's arm64 build lays it
 * out): what the guest writes as a pNext struct's size
 * @return {{size: number, align: number}}
 */
function c_layout(name, pointer = 0, array = "")
{
    let one;
    if(pointer) one = { size: 8, align: 8 };
    else
    {
        name = name.replace(/\bconst\b/g, "").trim();
        const t = name;
        let kind;
        for(let i = 0; i < 16 && !kind; i++)
        {
            if(PRIMITIVES[name]) kind = PRIMITIVES[name];
            else if(types.get(name) === "enum") kind = "i32";
            else if(types.get(name) === "handle") kind = "u64";
            else if(types.get(name) === "struct" || types.get(name) === "union")
            {
                let size = 0, align = 1;
                for(const m of members.get(name).values())
                {
                    const l = c_layout(m.type, m.pointer, m.array);
                    if(types.get(name) === "union") size = Math.max(size, l.size);
                    else size = Math.ceil(size / l.align) * l.align + l.size;
                    align = Math.max(align, l.align);
                }
                one = { size: Math.ceil(size / align) * align, align };
                kind = "struct";
            }
            else if(/^PFN_/.test(name)) kind = "u64";
            else if(types.has(name)) name = types.get(name);
            else throw new Error("the layout of " + t);
        }
        if(!one) one = { size: SIZES[kind], align: SIZES[kind] };
    }
    let count = 1;
    for(const d of array.matchAll(/\[([^\]]*)\]/g))
    {
        const n = /^\d+$/.test(d[1].trim()) ? +d[1] : constants.get(d[1].trim());
        if(n === undefined) throw new Error("an array size " + d[1]);
        count *= n;
    }
    return { size: one.size * count, align: one.align };
}

const constants = new Map();
{
    const pending = [];
    for(const m of header_text.matchAll(/^\s+(VK_\w+)\s*=\s*([^,\n]+?),?\s*$/gm)) pending.push([m[1], m[2].trim()]);
    for(const m of header_text.matchAll(/^#define\s+(VK_\w+)\s+(.+?)\s*$/gm)) pending.push([m[1], m[2].trim()]);
    // (extensions' enums by macro: VK_X_ENUM(type, id) is 1000000000 + 1000 * (number - 1) + id)
    const defines = (header_text + "\n" + read(path.join(enc_dir, "vulkan_gfxstream_structure_type.h"))).replace(/\\\n/g, " ");
    const numbers = { VK_GOOGLE_GFXSTREAM_ENUM: 386, VK_ANDROID_NATIVE_BUFFER_ENUM: 11 };
    for(const m of defines.matchAll(/^#define\s+(VK_\w+)\s+(VK_\w+_ENUM)\(\w+,\s*(\d+)\)/gm))
    {
        if(numbers[m[2]]) pending.push([m[1], String(1000000000 + 1000 * (numbers[m[2]] - 1) + +m[3])]);
    }
    const value = text => {
        text = text.replace(/\/\/.*$|\/\*.*?\*\//g, "").trim();
        let m;
        if((m = /^\(\(\w+\)\s*(-?\d+)\)$/.exec(text))) return +m[1];
        if((m = /^(-?(?:0x[0-9a-fA-F]+|\d+))U?(?:LL|ULL)?$/.exec(text))) return Number(m[1]);
        if((m = /^\(?(\d+)U?\s*<<\s*(\d+)\)?$/.exec(text))) return m[1] * 2 ** +m[2];
        if(/^VK_\w+$/.test(text)) return constants.get(text);
        if((m = /^\(~0U\)$/.exec(text))) return 0xFFFFFFFF;
        if((m = /^\(~0ULL\)$/.exec(text))) return 2 ** 64;
        if((m = /^\(~1U\)$/.exec(text))) return 0xFFFFFFFE;
        if((m = /^\(~2U\)$/.exec(text))) return 0xFFFFFFFD;
        return undefined;
    };
    for(let round = 0; round < 4; round++)
    {
        for(const [name, text] of pending)
        {
            if(constants.has(name)) continue;
            const v = value(text);
            if(typeof v === "number" && !Number.isNaN(v)) constants.set(name, v);
        }
    }
    for(const m of header_text.matchAll(/^static const \w+ (VK_\w+) = (0x[0-9a-fA-F]+)ULL;/gm)) constants.set(m[1], Number(BigInt(m[2])));
    for(const [name, bit] of Object.entries(FEATURE_BITS)) constants.set(name, bit);
}

// ---------------------------------------------------------------------------
// C: tokens, expressions, statements

/**
 * @param {string} src
 * @return {!Array<{t: string, v: string}>}
 */
function tokenize(src)
{
    const out = [];
    const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|^[ \t]*#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)[uUlLfF]*|([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)|(->|\+\+|--|<<=|>>=|<<|>>|<=|>=|==|!=|&&|\|\||\+=|-=|\*=|\/=|&=|\|=|::|.)/gmy;
    let m;
    while(re.lastIndex < src.length && (m = re.exec(src)))
    {
        const text = m[0];
        if(m[1] !== undefined) out.push({ t: "num", v: m[1] });
        else if(m[2] !== undefined) out.push({ t: "id", v: m[2] });
        else if(m[3] !== undefined) out.push({ t: "op", v: m[3] });
        else if(text[0] === "\"") out.push({ t: "str", v: text });
        else if(text[0] === "'") out.push({ t: "num", v: String(text.charCodeAt(1)) });
    }
    return out;
}

const TYPE_WORDS = new Set(["const", "struct", "unsigned"]);
function is_type_name(v)
{
    return TYPE_WORDS.has(v) || PRIMITIVES[v] !== undefined || types.has(v) || /^PFN_/.test(v) || v === "auto";
}

/** A parser over tokens */
class Parser
{
    constructor(tokens) { this.tokens = tokens; this.i = 0; }
    peek(k = 0) { return this.tokens[this.i + k]; }
    is(v, k = 0) { const t = this.peek(k); return t && t.v === v && t.t !== "str"; }
    next() { return this.tokens[this.i++]; }
    expect(v)
    {
        const t = this.next();
        if(!t || t.v !== v) throw new Error(`expected ${v}, got ${t ? t.v : "the end"} at ${this.context()}`);
        return t;
    }
    context() { return this.tokens.slice(Math.max(0, this.i - 8), this.i + 8).map(t => t.v).join(" "); }

    // A type in a cast or a declaration: words, then stars
    type_at(k)
    {
        const at = j => this.tokens[j];
        let j = k, words = [];
        while(at(j) && at(j).t === "id" && is_type_name(at(j).v)) words.push(at(j++).v);
        if(!words.length || words.every(w => TYPE_WORDS.has(w))) return null;
        let stars = 0;
        for(;;)
        {
            if(at(j) && at(j).v === "*") { stars++; j++; }
            else if(at(j) && at(j).v === "const") j++;
            else break;
        }
        return { name: words.filter(w => !TYPE_WORDS.has(w)).join(" "), stars, end: j };
    }

    expr() { return this.assign(); }
    assign()
    {
        const left = this.ternary();
        const t = this.peek();
        if(t && t.t === "op" && ["=", "+=", "-=", "*=", "/=", "&=", "|=", "<<=", ">>="].includes(t.v))
        {
            this.next();
            return { k: "assign", op: t.v, l: left, r: this.assign() };
        }
        return left;
    }
    ternary()
    {
        const c = this.binary(0);
        if(this.is("?"))
        {
            this.next();
            const t = this.assign();
            this.expect(":");
            return { k: "cond", c, t, f: this.assign() };
        }
        return c;
    }
    binary(level)
    {
        const LEVELS = [["||"], ["&&"], ["|"], ["^"], ["&"], ["==", "!="], ["<", "<=", ">", ">="], ["<<", ">>"], ["+", "-"], ["*", "/", "%"]];
        if(level === LEVELS.length) return this.unary();
        let left = this.binary(level + 1);
        for(;;)
        {
            const t = this.peek();
            if(!t || t.t !== "op" || !LEVELS[level].includes(t.v)) return left;
            this.next();
            left = { k: "bin", op: t.v, l: left, r: this.binary(level + 1) };
        }
    }
    unary()
    {
        const t = this.peek();
        if(t && t.t === "op" && ["!", "-", "*", "&", "~", "++", "--", "+"].includes(t.v))
        {
            this.next();
            return { k: "unary", op: t.v, e: this.unary() };
        }
        if(t && t.v === "sizeof" && t.t === "id")
        {
            this.next();
            this.expect("(");
            const type = this.type_at(this.i);
            if(type && this.tokens[type.end] && this.tokens[type.end].v === ")")
            {
                this.i = type.end + 1;
                return { k: "sizeof", type: type.name, stars: type.stars };
            }
            const e = this.expr();
            this.expect(")");
            return { k: "sizeof", e };
        }
        // a cast
        if(this.is("("))
        {
            const type = this.type_at(this.i + 1);
            if(type && this.tokens[type.end] && this.tokens[type.end].v === ")")
            {
                this.i = type.end + 1;
                return { k: "cast", type: type.name, stars: type.stars, e: this.unary() };
            }
        }
        // reinterpret_cast<T*>(e)
        if(t && t.v === "reinterpret_cast")
        {
            this.next();
            this.expect("<");
            const type = this.type_at(this.i);
            if(!type) throw new Error("an unknown type " + this.peek().v + " " + this.peek(1).v);
            this.i = type.end;
            this.expect(">");
            this.expect("(");
            const e = this.expr();
            this.expect(")");
            return { k: "cast", type: type.name, stars: type.stars, e };
        }
        return this.postfix(this.primary());
    }
    primary()
    {
        const t = this.next();
        if(!t) throw new Error("an expression ends early");
        if(t.t === "num") return { k: "num", v: t.v };
        if(t.t === "str") return { k: "str", v: t.v };
        if(t.t === "id") return { k: "id", v: t.v };
        if(t.v === "(")
        {
            const e = this.expr();
            this.expect(")");
            return e;
        }
        // a lambda: [](T s) { return e; }
        if(t.v === "[")
        {
            this.expect("]");
            this.expect("(");
            const type = this.type_at(this.i);
            this.i = type.end;
            const param = this.next().v;
            this.expect(")");
            this.expect("{");
            if(this.next().v !== "return") throw new Error("a lambda that is not a return");
            const body = this.expr();
            this.expect(";");
            this.expect("}");
            return { k: "lambda", param, body };
        }
        throw new Error("unexpected " + t.v + " at " + this.context());
    }
    postfix(e)
    {
        for(;;)
        {
            if(this.is("->") || this.is("."))
            {
                const arrow = this.next().v === "->";
                e = { k: "member", o: e, name: this.next().v, arrow };
            }
            else if(this.is("["))
            {
                this.next();
                const i = this.expr();
                this.expect("]");
                e = { k: "index", o: e, i };
            }
            else if(this.is("("))
            {
                this.next();
                const args = [];
                while(!this.is(")"))
                {
                    args.push(this.assign());
                    if(this.is(",")) this.next();
                }
                this.expect(")");
                e = { k: "call", f: e, args };
            }
            else if(this.is("++") || this.is("--")) e = { k: "post", op: this.next().v, e };
            else return e;
        }
    }

    statement()
    {
        const t = this.peek();
        if(this.is("{"))
        {
            this.next();
            const body = [];
            while(!this.is("}")) body.push(this.statement());
            this.next();
            return { k: "block", body };
        }
        if(this.is(";")) { this.next(); return { k: "empty" }; }
        if(t.t === "id" && t.v === "if")
        {
            this.next();
            this.expect("(");
            const cond = this.expr();
            this.expect(")");
            const then = this.statement();
            let otherwise = null;
            if(this.is("else")) { this.next(); otherwise = this.statement(); }
            return { k: "if", cond, then, else: otherwise };
        }
        if(t.t === "id" && t.v === "for")
        {
            this.next();
            this.expect("(");
            const init = this.is(";") ? null : this.simple();
            this.expect(";");
            const cond = this.expr();
            this.expect(";");
            const step = this.expr();
            this.expect(")");
            return { k: "for", init, cond, step, body: this.statement() };
        }
        if(t.t === "id" && t.v === "switch")
        {
            this.next();
            this.expect("(");
            const e = this.expr();
            this.expect(")");
            this.expect("{");
            const cases = [];
            while(!this.is("}"))
            {
                if(this.is("case")) { this.next(); const label = this.expr(); this.expect(":"); cases.push({ label, body: [] }); }
                else if(this.is("default")) { this.next(); this.expect(":"); cases.push({ label: null, body: [] }); }
                else cases.at(-1).body.push(this.statement());
            }
            this.next();
            return { k: "switch", e, cases };
        }
        if(t.t === "id" && (t.v === "break" || t.v === "continue")) { this.next(); this.expect(";"); return { k: t.v }; }
        if(t.t === "id" && t.v === "return")
        {
            this.next();
            const e = this.is(";") ? null : this.expr();
            this.expect(";");
            return { k: "return", e };
        }
        const s = this.simple();
        this.expect(";");
        return s;
    }
    // a declaration or an expression
    simple()
    {
        const type = this.type_at(this.i);
        if(type && this.tokens[type.end] && this.tokens[type.end].t === "id" && !is_type_name(this.tokens[type.end].v))
        {
            const after = this.tokens[type.end + 1];
            if(after && (after.v === "=" || after.v === ";" || after.v === "[" || after.v === ","))
            {
                this.i = type.end;
                const name = this.next().v;
                while(this.is("[")) { this.next(); this.expr(); this.expect("]"); }
                let init = null;
                if(this.is("=")) { this.next(); init = this.assign(); }
                return { k: "decl", type: type.name, stars: type.stars, name, init };
            }
        }
        return { k: "expr", e: this.expr() };
    }
}

/** C as text again (for messages and keys) */
function c_text(e)
{
    switch(e.k)
    {
        case "num": case "id": case "str": return e.v;
        case "member": return c_text(e.o) + (e.arrow ? "->" : ".") + e.name;
        case "index": return c_text(e.o) + "[" + c_text(e.i) + "]";
        case "call": return c_text(e.f) + "(" + e.args.map(c_text).join(", ") + ")";
        case "unary": return e.op + "(" + c_text(e.e) + ")";
        case "post": return c_text(e.e) + e.op;
        case "bin": return "(" + c_text(e.l) + " " + e.op + " " + c_text(e.r) + ")";
        case "cond": return "(" + c_text(e.c) + " ? " + c_text(e.t) + " : " + c_text(e.f) + ")";
        case "assign": return c_text(e.l) + " " + e.op + " " + c_text(e.r);
        case "cast": return "(" + e.type + "*".repeat(e.stars) + ")" + c_text(e.e);
        case "sizeof": return "sizeof(" + (e.type ? e.type + "*".repeat(e.stars) : c_text(e.e)) + ")";
        case "lambda": return "[](" + e.param + "){" + c_text(e.body) + "}";
    }
    return "?" + e.k;
}
function s_text(s)
{
    switch(s.k)
    {
        case "expr": return c_text(s.e) + ";";
        case "decl": return s.type + "*".repeat(s.stars) + " " + s.name + (s.init ? " = " + c_text(s.init) : "") + ";";
        case "if": return "if (" + c_text(s.cond) + ") ...";
        case "for": return "for (... " + c_text(s.cond) + " ...) ...";
        default: return s.k;
    }
}

/** The C functions of a file: name -> {params: [[type, name]], body: statements} */
function functions_of(file, pattern)
{
    const src = read(file);
    const out = new Map();
    const re = new RegExp("^(?:\\w[\\w\\s\\*]*?)\\s\\**(" + pattern + ")\\(([^)]*)\\)\\s*\\{", "gm");
    let m;
    while((m = re.exec(src)))
    {
        // the body: to the matching brace
        let depth = 0, at = re.lastIndex - 1, end = -1;
        for(let i = at; i < src.length; i++)
        {
            const c = src[i];
            if(c === "\"") { i++; while(src[i] !== "\"") { if(src[i] === "\\") i++; i++; } continue; }
            if(c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
            if(c === "{") depth++;
            else if(c === "}" && --depth === 0) { end = i; break; }
        }
        let body = src.slice(at + 1, end);
        // (the .inl a function includes)
        body = body.replace(/^#include "(\w+\.cpp\.inl)"$/m, (_, inl) => read(path.join(path.dirname(file), inl)));
        const params = m[2].split(",").map(p => p.trim()).filter(Boolean).map(p => {
            const d = /^(.*?)(\w+)\s*(\[[^\]]*\])?$/.exec(p);
            if(!d) throw new Error(m[1] + ": a parameter " + p);
            return [d[1].replace(/\s+/g, " ").trim(), d[2]];
        });
        out.set(m[1], { name: m[1], params, text: body });
        re.lastIndex = end;
    }
    return out;
}
function parse_body(text, name)
{
    const p = new Parser(tokenize(text));
    const body = [];
    try
    {
        while(p.i < p.tokens.length) body.push(p.statement());
    }
    catch(e)
    {
        e.message = (name || "?") + ": " + e.message;
        throw e;
    }
    return body;
}

// ---------------------------------------------------------------------------
// Constant folding: the stream's features, the guest's constant choices

function fold(e)
{
    const num = v => ({ k: "num", v: String(v) });
    const value = x => x.k === "num" ? Number(x.v) : null;
    switch(e.k)
    {
        case "id":
            if(e.v === "queueSubmitWithCommandsEnabled") return num(1);
            if(e.v === "nullptr" || e.v === "NULL") return num(0);
            if(e.v === "true") return num(1);
            if(e.v === "false") return num(0);
            if(FEATURE_BITS[e.v] !== undefined) return num(FEATURE_BITS[e.v]);
            return e;
        case "call":
        {
            const f = c_text(e.f);
            if(/->getFeatureBits$/.test(f)) return num(FEATURES);
            if(f === "sResourceTracker->usingDirectMapping") return num(1);
            return { ...e, args: e.args.map(fold) };
        }
        case "unary":
        {
            const x = fold(e.e);
            if(value(x) !== null)
            {
                if(e.op === "!") return num(value(x) ? 0 : 1);
                if(e.op === "-") return num(-value(x));
            }
            return { ...e, e: x };
        }
        case "bin":
        {
            const l = fold(e.l), r = fold(e.r);
            const a = value(l), b = value(r);
            if(e.op === "||")
            {
                if(a !== null) return a ? num(1) : r;
                if(b !== null) return b ? num(1) : l;
            }
            if(e.op === "&&")
            {
                if(a !== null) return a ? r : num(0);
                if(b !== null) return b ? l : num(0);
            }
            if(a !== null && b !== null)
            {
                const v = { "&": a & b, "|": a | b, "==": +(a === b), "!=": +(a !== b), "+": a + b, "*": a * b }[e.op];
                if(v !== undefined) return num(v);
            }
            return { ...e, l, r };
        }
        case "cond":
        {
            const c = fold(e.c);
            if(value(c) !== null) return value(c) ? fold(e.t) : fold(e.f);
            return { ...e, c, t: fold(e.t), f: fold(e.f) };
        }
        case "cast": return { ...e, e: fold(e.e) };
        case "member": return { ...e, o: fold(e.o) };
        case "index": return { ...e, o: fold(e.o), i: fold(e.i) };
        case "assign": return { ...e, l: fold(e.l), r: fold(e.r) };
        case "post": return { ...e, e: fold(e.e) };
    }
    return e;
}
/** statements with their feature tests decided */
function fold_statements(list)
{
    const out = [];
    for(const s of list)
    {
        if(s.k === "if")
        {
            const cond = fold(s.cond);
            if(cond.k === "num")
            {
                const taken = Number(cond.v) ? s.then : s.else;
                if(taken) out.push(...fold_statements(taken.k === "block" ? taken.body : [taken]));
                continue;
            }
            out.push({ ...s, cond, then: fold_block(s.then), else: s.else && fold_block(s.else) });
        }
        else if(s.k === "block") out.push({ k: "block", body: fold_statements(s.body) });
        else if(s.k === "for") out.push({ ...s, cond: fold(s.cond), body: fold_block(s.body) });
        else if(s.k === "expr") out.push({ k: "expr", e: fold(s.e) });
        else if(s.k === "decl") out.push({ ...s, init: s.init && fold(s.init) });
        else if(s.k !== "empty") out.push(s);
    }
    return out;
}
function fold_block(s) { return { k: "block", body: fold_statements(s.k === "block" ? s.body : [s]) }; }

// ---------------------------------------------------------------------------
// Translation

/** an expression without its casts */
function bare(e)
{
    while(e.k === "cast") e = e.e;
    return e;
}
/** an lvalue: *&x, *(x), (x) are x */
function lvalue(e)
{
    e = bare(e);
    for(;;)
    {
        if(e.k === "unary" && (e.op === "*" || e.op === "&")) e = bare(e.e);
        else return e;
    }
}
const SIZEOF = t => {
    const kind = kind_of(t);
    if(SIZES[kind] === undefined) throw new Error("the size of " + t);
    return SIZES[kind];
};
/**
 * A memcpy's or a read's size: count * sizeof(type), sizeof(type), or bytes
 * @return {{count: (Object|null), type: (string|null), bytes: (Object|null)}}
 */
function size_of(e)
{
    e = bare(e);
    if(e.k === "sizeof" && e.type) return { count: null, type: e.type, bytes: null };
    if(e.k === "bin" && e.op === "*")
    {
        const r = bare(e.r), l = bare(e.l);
        if(r.k === "sizeof" && r.type) return { count: l, type: r.type, bytes: null };
        if(l.k === "sizeof" && l.type) return { count: r, type: l.type, bytes: null };
        if(l.k === "num" && r.k === "num") return { count: null, type: null, bytes: { k: "num", v: String(l.v * r.v) } };
    }
    return { count: null, type: null, bytes: e };
}

/** element readers and writers of arrays, by a kind */
const ARRAYS = { u8: "u8s", u16: "u16s", u32: "u32s", i32: "i32s", f32: "f32s", u64: "u64s", i64: "i64s", h: "u64s", void: "bytes_of" };

class Translator
{
    /**
     * @param {string} mode "decode" (reads into objects) or "encode" (writes from them)
     * @param {string} source "writes" (the guest's request writers) or "reads" (its reply readers)
     * @param {string} name for messages
     * @param {Set<string>} params a command's parameters (their names are a.name)
     * @param {string} prefix of the struct functions called
     */
    constructor(mode, source, name, params, prefix)
    {
        this.mode = mode;
        this.source = source;
        this.name = name;
        this.params = params;
        this.prefix = prefix;
        this.lines = [];
        this.depth = 1;
        /** C locals: name -> {k, ...} */
        this.env = new Map();
        /** decode: pointers' presence, by the C text of the pointer */
        this.presence = new Map();
        this.pending = null;
        this.array_advance = false;
        this.serial = 0;
        /** struct functions called */
        this.calls = new Set();
        /** a command's output handles (the parameters its reply maps) */
        this.handles = new Set();
    }
    fail(what) { throw new Error(`${this.name}: ${what}`); }
    emit(line) { this.lines.push("    ".repeat(this.depth) + line); }
    fresh(base) { return base + this.serial++; }

    /** C to JS */
    js(e)
    {
        switch(e.k)
        {
            case "num":
            {
                const v = Number(e.v);
                if(!Number.isFinite(v)) this.fail("a number " + e.v);
                return String(v);
            }
            case "id":
            {
                const v = e.v;
                if(v === "forMarshaling" || v === "forUnmarshaling") return "o";
                if(v === "rootType") return "root";
                const local = this.env.get(v);
                if(local && local.js) return local.js;
                if(local && local.k === "loop") return v;
                if(v.startsWith("local_") && this.params.has(v.slice(6))) return "a." + v.slice(6);
                if(this.params.has(v)) return "a." + v;
                if(constants.has(v)) return String(constants.get(v));
                this.fail("unknown name " + v);
                break;
            }
            case "member": return this.js(e.o) + "." + e.name;
            // (encoding: an array the object does not have reads as undefined: zeros)
            case "index": return this.js(e.o) + (this.mode === "encode" ? "?.[" : "[") + this.js(e.i) + "]";
            case "cast": return this.js(e.e);
            case "unary":
                if(e.op === "*" || e.op === "&") return this.js(e.e);
                if(e.op === "!") return "!" + this.js(e.e);
                return "(" + e.op + this.js(e.e) + ")";
            case "bin":
            {
                const op = { "==": "===", "!=": "!==" }[e.op] || e.op;
                // (a pointer against 0: null)
                const zero = x => bare(x).k === "num" && Number(bare(x).v) === 0;
                if((e.op === "==" || e.op === "!=") && (zero(e.l) || zero(e.r)) && this.pointerish(zero(e.l) ? e.r : e.l))
                {
                    return "(" + this.js(zero(e.l) ? e.r : e.l) + (e.op === "==" ? " == null" : " != null") + ")";
                }
                return "(" + this.js(e.l) + " " + op + " " + this.js(e.r) + ")";
            }
            case "cond": return "(" + this.js(e.c) + " ? " + this.js(e.t) + " : " + this.js(e.f) + ")";
            case "sizeof": return String(e.type ? (e.stars ? 8 : SIZEOF(e.type)) : this.fail("sizeof " + c_text(e)));
            case "call":
            {
                const f = c_text(e.f);
                if(f === "strlen") return this.js(e.args[0]) + ".length";
                if(f === "arrayany")
                {
                    const lambda = e.args[3];
                    this.env.set(lambda.param, { k: "loop" });
                    const body = this.js(lambda.body);
                    this.env.delete(lambda.param);
                    return `arrayany(${this.js(e.args[0])}, ${this.js(e.args[1])}, ${this.js(e.args[2])}, ${lambda.param} => ${body})`;
                }
                this.fail("a call in an expression: " + c_text(e));
                break;
            }
        }
        this.fail("an expression " + c_text(e));
    }
    /** whether a C value is a pointer (null when absent) */
    pointerish(e)
    {
        e = lvalue(e);
        const name = e.k === "member" ? e.name : e.k === "id" ? e.v.replace(/^local_/, "") : null;
        return name !== null && (/^p+[A-Z]/.test(name) || name === "handle" || this.presence.has(c_text(e)));
    }
    /** a condition: a pointer's presence where it is one */
    condition(e)
    {
        // (*pCount): the value, not the pointer
        if(bare(e).k === "unary" && bare(e).op === "*") return this.js(e);
        const key = c_text(lvalue(e));
        if(this.mode === "decode" && this.source === "writes" && this.presence.has(key)) return this.presence.get(key);
        if(this.pointerish(e) && (lvalue(e).k === "member" || lvalue(e).k === "id") && bare(e).k !== "bin") return this.js(e) + " != null";
        return this.js(e);
    }

    run(list)
    {
        for(let i = 0; i < list.length; i++) i = this.statement(list, i);
        this.flush_pending();
    }
    flush_pending()
    {
        if(!this.pending) return;
        // a memcpy without moving on: what comes next overwrites it
        const p = this.pending;
        this.pending = null;
        if(this.source !== "writes") return;
        const src = bare(p.src);
        if(this.mode === "decode") this.emit(`${this.js(lvalue(src))} = r.peek_u32();`);
    }

    /** @return {number} the last statement it took */
    statement(list, i)
    {
        const s = list[i];
        if(s.k !== "expr" || !this.is_be(s.e) && !this.is_advance(s.e)) this.flush_pending();
        switch(s.k)
        {
            case "decl": this.declare(s); return i;
            case "expr": return this.expression(s.e, list, i);
            case "block":
                this.run(s.body);
                return i;
            case "if": this.if_statement(s); return i;
            case "for": this.for_statement(s); return i;
            case "return": return list.length;
            case "break": case "continue": return i;
        }
        this.fail("a statement " + s_text(s));
    }
    is_be(e) { return e.k === "call" && /Stream::toBe(32|64)$/.test(c_text(e.f)); }
    is_advance(e) { return e.k === "assign" && e.op === "+=" && /^\*\(?(ptr|streamPtrPtr)\)?$|^\*\((ptr|streamPtrPtr)\)$/.test(c_text(e.l).replace(/\s/g, "")); }

    declare(s)
    {
        const init = s.init;
        const name = s.name;
        if(!init)
        {
            // cgen_var_N, check_X, uint64_t* cgen_var (handles), a placeholder
            this.env.set(name, { k: s.stars ? "cv_array" : "cv", type: s.type });
            return;
        }
        const b = bare(init);
        if(name === "structAccess") return;
        // uint64_t cgen_var = (uint64_t)(uintptr_t)p: a pointer's presence
        if(init.k === "cast" && init.e.k === "cast" && init.e.type === "uintptr_t")
        {
            this.env.set(name, { k: "presence", lv: lvalue(init.e.e) });
            return;
        }
        // uint32_t l = s ? strlen(s) : 0: a string's length
        if(b.k === "cond" && bare(b.t).k === "call" && c_text(bare(b.t).f) === "strlen")
        {
            this.env.set(name, { k: "strlen", lv: lvalue(bare(b.t).args[0]) });
            return;
        }
        // uint8_t* cgen_var_N_ptr = (uint8_t*)(*ptr): a handle array's start
        if(c_text(b).replace(/\W/g, "") === "ptr" || c_text(b).replace(/\W/g, "") === "streamPtrPtr")
        {
            this.env.set(name, { k: "array_base" });
            return;
        }
        // uint64_t tmpval = get_host_u64_VkX(a[k]) or (uint64_t)(a[k]): a handle
        if(name === "tmpval")
        {
            const v = b.k === "call" && /^get_host_u64_/.test(c_text(b.f)) ? b.args[0] : b;
            this.env.set(name, { k: "handle", lv: lvalue(v) });
            return;
        }
        // uint64_t cgen_var = (uint64_t)x: a size_t, a function pointer, a local, big endian
        if(/^cgen_var/.test(name) && init.k === "cast")
        {
            this.env.set(name, { k: "value", lv: lvalue(init.e) });
            return;
        }
        // VkResult vkX_VkResult_return = (VkResult)0: the return value
        if(/_return$/.test(name))
        {
            this.env.set(name, { k: "return", type: s.type });
            return;
        }
        // uint32_t c = 0: a string array's count (set in its block); a local flag
        if(b.k === "num")
        {
            const js = name === "c" ? this.fresh("c") : name;
            this.env.set(name, { k: name === "c" ? "count" : "local", js, lv: null });
            this.emit(`let ${js} = ${this.js(b)};`);
            return;
        }
        // VkResult vkX_VkResult_return = (VkResult)0: the return value
        if(/_return$/.test(name))
        {
            this.env.set(name, { k: "return", type: s.type });
            return;
        }
        // (the guest's own: auto range = ..., ...)
        if(s.type === "auto") return;
        this.fail("a declaration " + s_text(s));
    }

    expression(e, list, i)
    {
        const f = e.k === "call" ? c_text(e.f) : "";
        if(e.k === "cast" && e.type === "void") return i;
        if(e.k === "post" || e.k === "unary" && (e.op === "++" || e.op === "--")) return i;
        if(e.k === "assign") return this.assignment(e, list, i);
        if(e.k !== "call") this.fail("an expression statement " + c_text(e));
        if(/^(fprintf|MESA_TRACE_SCOPE|mesa_log\w*)$/.test(f)) return i;
        if(/^(pool->freeAll|stream->clearPool|stream->flush|stream->setHandleMapping|stream->unsetHandleMapping|this->unlock|this->lock|vkStream->alloc|stream->alloc)$/.test(f)) return i;
        if(/^sResourceTracker->|^transform_|^stream->handleMapping\(\)->mapHandles_Vk|->destroyMapping\(\)/.test(f) && !/mapHandles_u64/.test(f)) return i;
        if(this.source === "writes") return this.write_call(e, f, list, i);
        return this.read_call(e, f, list, i);
    }

    assignment(e, list, i)
    {
        const l = lvalue(e.l), r = bare(e.r);
        const ltext = c_text(l);
        if(this.is_advance(e))
        {
            if(this.source !== "writes") return i;
            if(this.pending) this.complete_write(this.pending);
            else if(!this.array_advance) this.fail("an advance without a write: " + c_text(e));
            this.pending = null;
            this.array_advance = false;
            return i;
        }
        if(e.op !== "=") this.fail("an assignment " + c_text(e));
        const local = l.k === "id" ? this.env.get(l.v) : null;
        // *&cgen_var = get_host_u64_VkX((*&x)) or (uint64_t)((*pX)): a handle (or an output one)
        if(local && local.k === "cv")
        {
            const v = r.k === "call" && /^get_host_u64_/.test(c_text(r.f)) ? r.args[0] : r;
            local.k = "handle";
            local.lv = lvalue(v);
            return i;
        }
        // c = n (a string array's count), a local flag
        if(local && (local.k === "count" || local.k === "local"))
        {
            if(local.k === "count") local.lv = r;
            else if(this.mode === "encode" && this.source === "writes") this.emit(`${local.js} = ${this.js(fold(e.r))} ? 1 : 0;`);
            return i;
        }
        if(this.source === "reads")
        {
            // check_X = (T*)(uintptr_t)stream->getBe64(): a pointer's presence
            if(local && (local.k === "cv" || local.k === "check" || /^check_/.test(ltext)) && r.k === "call" && /getBe64$/.test(c_text(r.f)))
            {
                const next = list[i + 1];
                const subject = next && next.k === "if" ? lvalue(next.cond) : null;
                if(this.mode === "encode") this.emit(subject ? `w.ptr(${this.js(subject)} != null);` : "w.ptr(1);");
                else this.emit("r.ptr();");
                return i;
            }
            // x = (size_t)stream->getBe64(): a size_t
            if(r.k === "call" && /getBe64$/.test(c_text(r.f)))
            {
                if(e.r.k === "cast" && e.r.stars) { this.emit(this.mode === "encode" ? `w.ptr(${this.js(l)} != null);` : "r.ptr();"); return i; }
                if(this.mode === "encode") this.emit(`w.be64(${this.js(l)});`);
                else this.emit(`${this.js(l)} = r.be64();`);
                return i;
            }
            // the guest's own fixups: in its decoding only
            if(this.mode === "decode") this.emit(`${this.js(l)} = ${this.js(e.r)};`);
            return i;
        }
        // rootType = forMarshaling->sType
        if(ltext === "rootType") { this.emit(`root = ${this.js(e.r)};`); return i; }
        // (the reply's reads)
        if(r.k === "call" && /getBe(32|64)$/.test(c_text(r.f))) return i;
        this.fail("an assignment " + c_text(e));
    }

    // --- the guest's writes (requests)

    write_call(e, f, list, i)
    {
        if(f === "memcpy")
        {
            const dst = c_text(bare(e.args[0])).replace(/[()\s]/g, "");
            if(dst === "*ptr" || dst === "*streamPtrPtr" || dst === "streamPtr")
            {
                if(dst === "streamPtr") return i; // (the header)
                this.flush_pending();
                this.pending = { src: e.args[1], size: e.args[2], be: 0 };
                return i;
            }
            // a handle array's element: memcpy(base + k * 8, &tmpval, 8)
            const d = bare(e.args[0]);
            if(d.k === "bin" && d.op === "+" && this.env.get(c_text(d.l)) && this.env.get(c_text(d.l)).k === "array_base")
            {
                const tmp = this.env.get("tmpval");
                if(!tmp || tmp.k !== "handle") this.fail("a handle array without its handle");
                if(this.mode === "decode") this.emit(`${this.js(tmp.lv)} = r.h();`);
                else this.emit(`w.h(${this.js(tmp.lv)});`);
                this.array_advance = true;
                return i;
            }
            this.fail("a memcpy to " + dst);
        }
        if(this.is_be(e))
        {
            if(!this.pending) this.fail("a byte swap without a write");
            this.pending.be = /toBe32$/.test(f) ? 32 : 64;
            return i;
        }
        let m;
        if((m = /^reservedmarshal_(\w+)$/.exec(f)))
        {
            const target = this.struct_target(e.args[2]);
            const root = this.js(fold(e.args[1]));
            if(m[1] === "extension_struct")
            {
                this.calls.add("pnext");
                if(this.mode === "decode") this.emit(`${target} = ${this.prefix}pnext(r, ${root});`);
                else this.emit(`${this.prefix}pnext(w, ${target}, ${root});`);
                return i;
            }
            this.calls.add(m[1]);
            if(this.mode === "decode") this.emit(`${target} = ${this.prefix}${m[1]}(r, ${root});`);
            else this.emit(`${this.prefix}${m[1]}(w, ${target}, ${root});`);
            return i;
        }
        // vkQueueFlushCommandsGOOGLE's data: the rest of the command
        if(f === "stream->writeLarge")
        {
            const target = this.js(lvalue(e.args[0])), n = this.js(e.args[1]);
            if(this.mode === "decode") this.emit(`${target} = r.bytes_of(${n});`);
            else this.emit(`w.bytes_of(${target}, ${n});`);
            return i;
        }
        if(f === "stream->write" || f === "stream->read" || /^stream->/.test(f) && this.source === "writes" && /read|getBe/.test(f)) return i;
        if(/^(stream|vkStream)->(read|getBe\d+|loadString\w*)$/.test(f) || /mapHandles_u64/.test(f)) return i;
        if(/^unmarshal_/.test(f)) return i;
        this.fail("a call " + c_text(e));
    }
    /** a struct's place: (T*)(&x), (T*)(x + i), (T*)(x) */
    struct_target(arg)
    {
        const b = bare(arg);
        if(b.k === "bin" && b.op === "+") return this.js(lvalue(b.l)) + (this.mode === "encode" ? "?.[" : "[") + this.js(b.r) + "]";
        return this.js(lvalue(b));
    }

    /** a write of the guest's (memcpy, its byte swap, its advance) */
    complete_write(p)
    {
        const src = bare(p.src);
        const size = size_of(p.size);
        const decode = this.mode === "decode";
        // &cgen_var, &l, &c: what a local holds
        if(src.k === "unary" && src.op === "&" && bare(src.e).k === "id" && this.env.has(bare(src.e).v))
        {
            const local = this.env.get(bare(src.e).v);
            switch(local.k)
            {
                case "presence":
                {
                    if(p.be !== 64) this.fail("a presence not big endian");
                    if(decode)
                    {
                        const v = this.fresh("p");
                        this.emit(`const ${v} = r.ptr();`);
                        this.presence.set(c_text(local.lv), v);
                        this.emit(`${this.js(local.lv)} = null;`);
                    }
                    else
                    {
                        this.presence.set(c_text(local.lv), true);
                        this.emit(`w.ptr(${this.js(local.lv)} != null);`);
                    }
                    return;
                }
                case "handle":
                    if(decode) this.emit(`${this.js(local.lv)} = r.h();`);
                    else this.emit(`w.h(${this.js(local.lv)});`);
                    return;
                case "value":
                {
                    const be = p.be === 64 ? "be64" : p.be === 32 ? "be32" : this.fail("a value not big endian");
                    const target = local.lv.k === "id" && this.env.get(local.lv.v) ? this.env.get(local.lv.v).js : this.js(local.lv);
                    if(decode) this.emit(`${target} = r.${be}();`);
                    else this.emit(`w.${be}(${target});`);
                    return;
                }
                case "strlen":
                {
                    if(p.be !== 32) this.fail("a string length not big endian");
                    const v = this.fresh("l");
                    if(decode)
                    {
                        this.emit(`const ${v} = r.be32();`);
                        this.emit(`${this.js(local.lv)} = "";`);
                    }
                    else this.emit(`const ${v} = ${this.js(local.lv)} ? ${this.js(local.lv)}.length : 0; w.be32(${v});`);
                    local.js = v;
                    return;
                }
                case "count":
                {
                    if(p.be !== 32) this.fail("a count not big endian");
                    if(decode) this.emit(`${local.js} = r.be32();`);
                    else { this.emit(`${local.js} = ${local.lv ? this.js(local.lv) : 0};`); this.emit(`w.be32(${local.js});`); }
                    return;
                }
            }
            this.fail("a write of a local " + local.k);
        }
        // (T*)&x with sizeof(T), (T*)x with sizeof(T) (what x points to), (T*)x with n * sizeof(T)
        const type = src.k === "cast" ? src.type : p.src.k === "cast" ? p.src.type : null;
        const inner = lvalue(src);
        if(!type && src.k !== "id" && src.k !== "member") this.fail("a write of " + c_text(p.src));
        const t = type || size.type;
        const kind = kind_of(t);
        const target = this.js(inner);
        if(size.type && !size.count)
        {
            if(SIZES[kind] === undefined) this.fail("a scalar " + t);
            if(decode) this.emit(`${target} = r.${kind}();`);
            else this.emit(`w.${kind}(${target});`);
            return;
        }
        const n = size.count ? this.js(fold(size.count)) : this.js(size.bytes);
        if(kind === "char")
        {
            // a string's bytes (its length before), or a fixed array of them
            if(decode) this.emit(`${target} = r.str(${n});`);
            else this.emit(size.count ? `w.str(${target}, ${n});` : `w.chars(${target}, ${n});`);
            return;
        }
        const method = ARRAYS[kind];
        if(!method) this.fail("an array of " + t);
        if(decode) this.emit(`${target} = r.${method}(${n});`);
        else this.emit(`w.${method}(${target}, ${n});`);
    }

    // --- the guest's reads (replies)

    read_call(e, f, list, i)
    {
        let m;
        if(/^(vk)?[sS]tream->read$/.test(f))
        {
            const dst = bare(e.args[0]);
            const size = size_of(e.args[1]);
            const decode = this.mode === "decode";
            // &cgen_var (a handle, mapped next) or cgen_var (an array of them)
            const cv = lvalue(dst);
            if(cv.k === "id" && this.env.has(cv.v))
            {
                const local = this.env.get(cv.v);
                if(local.k === "cv" || local.k === "cv_array") { local.read = true; return i; }
                if(local.k === "return")
                {
                    const kind = kind_of(local.type);
                    if(decode) this.emit(`a.ret = r.${kind}();`);
                    else this.emit(`w.${kind}(a.ret);`);
                    return i;
                }
            }
            const type = dst.k === "cast" ? dst.type : e.args[0].k === "cast" ? e.args[0].type : size.type;
            if(!type) this.fail("a read without a type " + c_text(e));
            const kind = kind_of(type);
            const target = this.js(lvalue(dst));
            if(size.type && !size.count)
            {
                if(decode) this.emit(`${target} = r.${kind}();`);
                else this.emit(`w.${kind}(${target});`);
                return i;
            }
            const n = size.count ? this.js(fold(size.count)) : this.js(size.bytes);
            if(kind === "char")
            {
                if(decode) this.emit(`${target} = r.str(${n});`);
                else this.emit(`w.str(${target}, ${n});`);
                return i;
            }
            const method = ARRAYS[kind];
            if(!method) this.fail("an array of " + type);
            if(decode) this.emit(`${target} = r.${method}(${n});`);
            else this.emit(`w.${method}(${target}, ${n});`);
            return i;
        }
        if((m = /mapHandles_u64_(\w+)$/.exec(f)))
        {
            const cv = lvalue(e.args[0]);
            const local = this.env.get(cv.v);
            if(!local || !local.read) this.fail("a handle mapped before its read");
            const target = this.js(lvalue(e.args[1]));
            const n = this.js(fold(e.args[2]));
            const decode = this.mode === "decode";
            if(/^a\.\w+$/.test(target)) this.handles.add(target.slice(2));
            if(local.k === "cv")
            {
                if(n !== "1") this.fail("one handle, " + n);
                if(decode) this.emit(`${target} = r.h();`);
                else this.emit(`w.h(${target});`);
            }
            else
            {
                if(decode) this.emit(`${target} = r.u64s(${n});`);
                else this.emit(`w.u64s(${target}, ${n});`);
            }
            local.read = false;
            return i;
        }
        if(/^(vk)?[sS]tream->getBe32$/.test(f)) { this.emit(this.mode === "decode" ? "r.be32();" : "w.be32(0);"); return i; }
        if((m = /^(?:vk)?[sS]tream->(loadStringInPlace|loadStringArrayInPlace)$/.test(f)))
        {
            const target = this.js(lvalue(e.args[0]));
            const array = /Array/.test(f);
            if(this.mode === "decode") this.emit(`${target} = r.${array ? "strings" : "string"}();`);
            else this.emit(`w.${array ? "strings" : "string"}(${target});`);
            return i;
        }
        if((m = /^unmarshal_(\w+)$/.exec(f)))
        {
            const target = this.struct_target(e.args[2]);
            const root = this.js(fold(e.args[1]));
            const name = m[1] === "extension_struct" ? "pnext" : m[1];
            this.calls.add(name);
            if(this.mode === "decode") this.emit(`${target} = ${this.prefix}${name}(r, ${target}, ${root});`);
            else this.emit(`${this.prefix}${name}(w, ${target}, ${root});`);
            return i;
        }
        if(/^reservedmarshal_|^stream->writeLarge$|^stream->write$|^memcpy$|Stream::toBe(32|64)$/.test(f)) return i;
        this.fail("a call " + c_text(e));
    }

    // --- control

    if_statement(s)
    {
        // the reads' consistency checks: if (!(check_X)) fprintf(...)
        const c = bare(s.cond);
        if(c.k === "unary" && c.op === "!" && /^check_/.test(c_text(lvalue(c.e)))) return;
        // if (forMarshaling): the struct is there
        if(lvalue(c).k === "id" && /^for(Un)?[mM]arshaling$/.test(lvalue(c).v)) { this.run(block_of(s.then)); return; }
        // if (rootType == VK_STRUCTURE_TYPE_MAX_ENUM)
        if(c_text(s.cond).includes("rootType"))
        {
            this.emit(`if(${this.js(s.cond)})`);
        }
        else this.emit(`if(${this.condition(s.cond)})`);
        const at = this.lines.length;
        this.emit("{");
        this.depth++;
        this.run(block_of(s.then));
        // (decode: a present array's default, empty, when the block decodes something)
        if(this.mode === "decode" && this.source === "writes" && this.presence.has(c_text(lvalue(s.cond))) && uses_as_array(s.then, lvalue(s.cond)) &&
            this.lines.length > at + 1)
        {
            this.lines.splice(at + 1, 0, "    ".repeat(this.depth) + `${this.js(lvalue(s.cond))} = [];`);
        }
        this.depth--;
        this.emit("}");
        if(s.else)
        {
            this.emit("else");
            this.emit("{");
            this.depth++;
            this.run(block_of(s.else));
            this.depth--;
            this.emit("}");
        }
        // (nothing in it: dropped)
        if(this.lines.length === at + 2 && !s.else) this.lines.length = at - 1;
    }

    for_statement(s)
    {
        const init = s.init;
        let v, from;
        if(init && init.k === "decl") { v = init.name; from = init.init; }
        else if(init && init.k === "expr" && init.e.k === "assign") { v = c_text(init.e.l); from = init.e.r; }
        else this.fail("a loop " + s_text(s));
        const cond = bare(s.cond);
        if(cond.k !== "bin" || cond.op !== "<" || c_text(cond.l) !== v) this.fail("a loop's condition " + c_text(s.cond));
        this.env.set(v, { k: "loop" });
        const count = this.js(fold(cond.r));
        // the arrays it fills (decode): made before it
        const at = this.lines.length;
        this.emit(`for(let ${v} = ${this.js(from)}; ${v} < ${count}; ${v}++)`);
        this.emit("{");
        this.depth++;
        this.run(block_of(s.body));
        this.depth--;
        this.emit("}");
        if(this.lines.length === at + 3) { this.lines.length = at; this.env.delete(v); return; }
        if(this.mode === "decode")
        {
            const arrays = new Set();
            const re = new RegExp("^\\s*([\\w.\\[\\]]+?)\\[" + v + "\\] = ", "");
            for(const line of this.lines.slice(at + 2))
            {
                const m = re.exec(line);
                if(m && !m[1].includes("[" + v + "]")) arrays.add(m[1]);
            }
            const prelude = [...arrays].map(a => "    ".repeat(this.depth) + `${a} = new Array(r.count(${count}));`);
            this.lines.splice(at, 0, ...prelude);
        }
        this.env.delete(v);
    }
}

function block_of(s) { return s.k === "block" ? s.body : [s]; }
/** whether statements use a pointer as an array (decode: its default when present) */
function uses_as_array(s, lv)
{
    const key = c_text(lv);
    let found = false;
    const visit = e => {
        if(!e || typeof e !== "object" || found) return;
        if(e.k === "bin" && e.op === "+" && c_text(lvalue(e.l)) === key) found = true;
        if(e.k === "index" && c_text(lvalue(e.o)) === key) found = true;
        for(const v of Object.values(e)) if(v && typeof v === "object") Array.isArray(v) ? v.forEach(visit) : visit(v);
    };
    visit(s);
    return found;
}

// ---------------------------------------------------------------------------
// The sources

const reserved = functions_of(path.join(enc_dir, "goldfish_vk_reserved_marshaling_guest.cpp"), "reservedmarshal_\\w+");
const unmarshal = functions_of(path.join(enc_dir, "goldfish_vk_marshaling_guest.cpp"), "unmarshal_\\w+");
const encoder = functions_of(path.join(enc_dir, "VkEncoder.cpp"), "VkEncoder::vk\\w+");
const opcodes = new Map();
for(const m of read(path.join(enc_dir, "goldfish_vk_marshaling_guest.h")).matchAll(/^#define OP_(vk\w+) (\d+)$/gm)) opcodes.set(m[1], +m[2]);

/**
 * pNext: the structs each sType is, from a file's extension_struct switch
 * @return {Map<number, (string|Map<(number|string), string>)>}
 */
function pnext_table(fn, call)
{
    const body = fold_statements(parse_body(fn.text, fn.name));
    const sw = body.find(s => s.k === "switch");
    const table = new Map();
    const struct_of = list => {
        for(const s of list)
        {
            if(s.k === "expr" && s.e.k === "call" && c_text(s.e.f).startsWith(call)) return c_text(s.e.f).slice(call.length);
            if(s.k === "block") { const v = struct_of(s.body); if(v) return v; }
            if(s.k === "switch")
            {
                const by_root = new Map();
                for(const c of s.cases) by_root.set(c.label ? constant_of(c.label) : "default", struct_of(c.body));
                return by_root;
            }
        }
        return null;
    };
    for(const c of sw.cases)
    {
        if(!c.label) continue;
        const v = struct_of(c.body);
        if(v) table.set(constant_of(c.label), v);
    }
    return table;
}
function constant_of(e)
{
    e = bare(e);
    if(e.k === "id" && constants.has(e.v)) return constants.get(e.v);
    if(e.k === "num") return Number(e.v);
    throw new Error("a constant " + c_text(e));
}

const pnext_writes = pnext_table(reserved.get("reservedmarshal_extension_struct"), "reservedmarshal_");
const pnext_reads = pnext_table(unmarshal.get("unmarshal_extension_struct"), "unmarshal_");

/**
 * A struct's function, translated
 * @param {string} mode
 * @param {string} source
 * @param {string} name the struct's
 * @param {string} prefix
 */
function struct_function(mode, source, name, prefix)
{
    if(mode === "decode" && source === "writes" && name === "VkClearColorValue")
    {
        // (a union the guest writes as its float32: its bits, as each of its
        // members; the model reads uint32, as Venus's decoder gives it)
        return { text: `function ${prefix}${name}(r, root)\n{\n    const o = {};\n    o.uint32 = r.u32s(4);\n` +
            `    o.int32 = new Int32Array(o.uint32.buffer);\n    o.float32 = new Float32Array(o.uint32.buffer);\n    return o;\n}\n`, calls: [] };
    }
    const fn = (source === "writes" ? reserved : unmarshal).get((source === "writes" ? "reservedmarshal_" : "unmarshal_") + name);
    if(!fn) throw new Error("no function for " + name);
    const t = new Translator(mode, source, name, new Set(), prefix);
    t.run(fold_statements(parse_body(fn.text, fn.name)));
    const head = mode === "decode" ?
        (source === "writes" ? `function ${prefix}${name}(r, root)\n{\n    const o = {};\n` : `function ${prefix}${name}(r, o, root)\n{\n    o = o || {};\n`) :
        `function ${prefix}${name}(w, o, root)\n{\n    o = o || {};\n`;
    const tail = mode === "decode" ? "    return o;\n}\n" : "}\n";
    return { text: head + t.lines.join("\n") + (t.lines.length ? "\n" : "") + tail, calls: t.calls };
}

/**
 * A command's request (decode or encode) and reply (encode or decode), from
 * its VkEncoder function
 */
function command_functions(name, side)
{
    const fn = encoder.get("VkEncoder::" + name);
    const params = new Set(fn.params.map(p => p[1]).filter(p => p !== "doLock"));
    const body = fold_statements(parse_body(fn.text, name));
    // the wire: after the header (opcode, size, the sequence number)
    let start = body.findIndex(s => s.k === "expr" && s.e.k === "call" && c_text(s.e.f) === "memcpy" && /packetSize_/.test(c_text(s.e.args[1])));
    // (vkMapMemory, vkUnmapMemory: the guest's own)
    if(start < 0) return null;
    start += 2;
    while(start < body.length && body[start].k === "expr" && /seqno|streamPtr \+=|^\(streamPtr\)/.test(c_text(body[start].e))) start++;
    let end = body.findIndex((s, i) => i >= start && s.k === "expr" && s.e.k === "unary" && s.e.op === "++");
    if(end < 0) end = body.findIndex((s, i) => i >= start && s.k === "return");
    if(end < 0) end = body.length;
    const wire = body.slice(start, end);
    const prefix = side === "device" ? "" : "g";
    const request = new Translator(side === "device" ? "decode" : "encode", "writes", name, params, side === "device" ? "d_" : "ge_");
    request.run(wire);
    const reply = new Translator(side === "device" ? "encode" : "decode", "reads", name, params, side === "device" ? "e_" : "gd_");
    reply.run(wire);
    const in_command_buffer = /packetSize_\w+ -= 8/.test(fn.text);
    return { name, request, reply, in_command_buffer, prefix };
}

// ---------------------------------------------------------------------------
// Output

function generate(side)
{
    const device = side === "device";
    const out = [];
    const struct_decls = new Map();
    const want = [];
    const need = (kind, name) => {
        const key = kind + " " + name;
        if(struct_decls.has(key)) return;
        struct_decls.set(key, null);
        want.push([kind, name]);
    };
    const commands = [];
    for(const [name] of encoder)
    {
        const cmd = name.slice("VkEncoder::".length);
        if(!opcodes.has(cmd)) continue;
        const c = command_functions(cmd, side);
        if(!c) continue;
        commands.push(c);
        for(const s of c.request.calls) need("request", s);
        for(const s of c.reply.calls) need("reply", s);
    }
    // the chains' structs, all of them
    for(const v of pnext_writes.values()) for(const s of typeof v === "string" ? [v] : v.values()) need("request", s);
    for(const v of pnext_reads.values()) for(const s of typeof v === "string" ? [v] : v.values()) need("reply", s);
    while(want.length)
    {
        const [kind, name] = want.shift();
        if(name === "pnext") continue;
        const f = kind === "request" ?
            struct_function(device ? "decode" : "encode", "writes", name, device ? "d_" : "ge_") :
            struct_function(device ? "encode" : "decode", "reads", name, device ? "e_" : "gd_");
        struct_decls.set(kind + " " + name, f.text);
        for(const s of f.calls) need(kind, s);
    }
    out.push(...[...struct_decls.values()].filter(Boolean));
    // the structs by name, for tests: [request's, reply's]
    const struct_names = new Map();
    for(const key of struct_decls.keys())
    {
        const [kind, name] = key.split(" ");
        if(name === "pnext") continue;
        if(!struct_names.has(name)) struct_names.set(name, [null, null]);
        struct_names.get(name)[kind === "request" ? 0 : 1] = (kind === "request" ? (device ? "d_" : "ge_") : (device ? "e_" : "gd_")) + name;
    }
    const structs_row = [...struct_names].sort().map(([name, [q, p]]) => `    ${name}: [${q}, ${p}],`).join("\n");

    // pNext
    const entry = (prefix, name) => `[${prefix}${name}, ${c_layout(name).size}]`;
    const table_js = (table, prefix) => [...table].map(([stype, v]) => typeof v === "string" ? `    ${stype}: ${entry(prefix, v)},` :
        `    ${stype}: { ${[...v].map(([root, s]) => `${root === "default" ? "default" : root}: ${entry(prefix, s)}`).join(", ")} },`).join("\n");
    const rq = device ? "d_" : "ge_", rp = device ? "e_" : "gd_";
    out.push(`/** pNext's structs (requests), by sType (some by the chain's root too): [its function, its C size] */\nconst PNEXT_REQUEST = {\n${table_js(pnext_writes, rq)}\n};`);
    out.push(`/** pNext's structs (replies) */\nconst PNEXT_REPLY = {\n${table_js(pnext_reads, rp)}\n};`);
    if(device)
    {
        out.push(`function d_pnext(r, root)
{
    if(!r.be32()) return null;
    const stype = r.u32();
    const d = pnext_struct(PNEXT_REQUEST, stype, root);
    if(!d) throw new Error("gfxstream: struct " + stype + " in a chain");
    return d[0](r, root);
}
function e_pnext(w, o, root)
{
    if(!o) { w.be32(0); return; }
    const e = pnext_struct(PNEXT_REPLY, o.sType, root);
    if(!e) throw new Error("gfxstream: struct " + o.sType + " in a reply's chain");
    w.be32(e[1]);
    w.u32(o.sType);
    e[0](w, o, root);
}`);
    }
    else
    {
        out.push(`function ge_pnext(w, o, root)
{
    // (structs the guest does not know are skipped)
    while(o && !pnext_struct(PNEXT_REQUEST, o.sType, root)) o = o.pNext;
    if(!o) { w.be32(0); return; }
    const e = pnext_struct(PNEXT_REQUEST, o.sType, root);
    w.be32(e[1]);
    w.u32(o.sType);
    e[0](w, o, root);
}
function gd_pnext(r, o, root)
{
    while(o && !pnext_struct(PNEXT_REPLY, o.sType, root)) o = o.pNext;
    r.be32();
    if(!o) return o;
    r.u32();
    return pnext_struct(PNEXT_REPLY, o.sType, root)[0](r, o, root);
}`);
    }

    // commands
    const fn_text = (head, t) => `${head}\n{\n${head.includes("(r)") ? "    const a = {};\n" : ""}${t.lines.join("\n")}${t.lines.length ? "\n" : ""}${head.includes("(r)") ? "    return a;\n" : ""}}`;
    const rows = [];
    for(const c of commands)
    {
        const op = opcodes.get(c.name);
        if(device)
        {
            out.push(fn_text(`function d_${c.name}(r)`, c.request));
            const has_reply = c.reply.lines.length > 0;
            if(has_reply) out.push(fn_text(`function e_${c.name}(w, a)`, c.reply));
            const handles = [...c.reply.handles];
            rows.push(`    ${op}: ["${c.name}", d_${c.name}, ${has_reply ? "e_" + c.name : "null"}, ${c.in_command_buffer ? 1 : 0}${handles.length ? ", " + JSON.stringify(handles) : ""}],`);
        }
        else
        {
            out.push(fn_text(`function ge_${c.name}(w, a)`, c.request));
            const has_reply = c.reply.lines.length > 0;
            if(has_reply) out.push(`function gd_${c.name}(r, a)\n{\n${c.reply.lines.join("\n")}\n    return a;\n}`);
            rows.push(`    ${c.name}: [${op}, ge_${c.name}, ${has_reply ? "gd_" + c.name : "null"}, ${c.in_command_buffer ? 1 : 0}],`);
        }
    }
    return { functions: out, rows, commands, structs_row };
}

const here = path.dirname(url.fileURLToPath(import.meta.url));
const runtime = read(path.join(here, "gfxstream_protocol_runtime.js"));
const header = `// Generated by tools/gfxstream_protocol_gen.mjs from gfxstream's guest
// encoder (mesa src/gfxstream/guest/vulkan_enc, the build pinned in
// docs/gfxstream-protocol.md); do not edit.
//
// gfxstream's Vulkan wire format: d_* read a request the guest's driver
// encoded, into objects with the C names (structs) or an object of the
// parameters (commands); e_* write a reply the driver decodes, from such
// objects (what is missing is written as zeros, an empty array or a null
// pointer).

/* eslint-disable */
`;
const common = `
/** VK_STRUCTURE_TYPE_MAX_ENUM: a chain's root not set yet */
const ROOT_NONE = ${STRUCTURE_TYPE_MAX_ENUM};

function pnext_struct(table, stype, root)
{
    const v = table[stype];
    if(!v || Array.isArray(v)) return v || null;
    return v[root] || v["default"] || null;
}
/** whether one of a[start, end) holds */
function arrayany(a, start, end, f)
{
    for(let i = start; i < end; i++) if(a && f(a[i])) return true;
    return false;
}
`;

{
    const { functions, rows, commands, structs_row } = generate("device");
    const text = header + "\n" + runtime + common + "\n" + functions.join("\n") +
        `\n\n/** the commands by opcode: [name, decode the request, encode the reply (or null), in a command buffer's stream, the output handles] */\nexport const COMMANDS = {\n${rows.join("\n")}\n};\n` +
        `\n/** the structs by name (tests): [decode in a request, encode in a reply] */\nexport const STRUCTS = {\n${structs_row}\n};\n` +
        `\n/** the guest's stream features (all four for virtio-gpu) */\nexport const STREAM_FEATURES = ${FEATURES};\n`;
    fs.writeFileSync(out_file, text.replace(/\(ROOT_NONE_PLACEHOLDER\)/g, "ROOT_NONE"));
    console.log(`${out_file}: ${commands.length} commands, ${functions.length} functions`);
}
if(guest_file)
{
    const { functions, rows, structs_row } = generate("guest");
    const text = header.replace("d_* read a request", "(the guest's side, for tests) ge_* write a request as").replace("e_* write a reply the driver decodes", "gd_* read a reply as the driver does") +
        "\n" + runtime + common + "\n" + functions.join("\n") +
        `\n\n/** the commands by name: [opcode, encode the request, decode the reply (or null), in a command buffer's stream] */\nexport const GUEST_COMMANDS = {\n${rows.join("\n")}\n};\n` +
        `\n/** the structs by name: [encode in a request, decode in a reply] */\nexport const GUEST_STRUCTS = {\n${structs_row}\n};\n`;
    fs.writeFileSync(guest_file, text);
    console.log(`${guest_file}: written`);
}
