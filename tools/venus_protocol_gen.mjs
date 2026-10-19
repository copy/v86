#!/usr/bin/env node
// Generates src/graphics_adapters/virtio_gpu/venus_protocol.js, the Venus
// (Vulkan over virtio-gpu) wire format, from the C that Mesa generates for
// its guest driver (src/virtio/venus-protocol/vn_protocol_driver_*.h):
//
// - the driver's encoders (vn_encode_*) say how requests are laid out; they
//   become decoders here (the device reads what the driver wrote)
// - the driver's reply decoders (vn_decode_*) say how replies are laid out;
//   they become encoders (the device writes what the driver reads)
//
// The C is regular (one statement per line, a handful of shapes), so this
// translates it statement by statement rather than parsing C in general; a
// shape it does not know stops it.
//
// With --guest <file>, it also writes the other side (requests encoded,
// replies decoded: what the driver does) for tests that play the driver.
//
// usage: tools/venus_protocol_gen.mjs <venus-protocol dir> <vulkan_core.h> [out.js] [--guest guest.js]

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const guest_at = argv.indexOf("--guest");
const guest_file = guest_at >= 0 ? argv.splice(guest_at, 2)[1] : null;
const [proto_dir, vulkan_core, out_file = "src/graphics_adapters/virtio_gpu/venus_protocol.js"] = argv;
if(!proto_dir || !vulkan_core)
{
    console.error("usage: venus_protocol_gen.mjs <venus-protocol dir> <vulkan_core.h> [out.js]");
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Constants: enums and #defines of vulkan_core.h and the protocol's own

const constants = new Map();
{
    const sources = [fs.readFileSync(vulkan_core, "utf8"), fs.readFileSync(path.join(proto_dir, "vn_protocol_driver_defines.h"), "utf8")];
    const pending = [];
    for(const src of sources)
    {
        for(const m of src.matchAll(/^\s+(VK_\w+)\s*=\s*([^,\n]+?),?\s*$/gm)) pending.push([m[1], m[2].trim()]);
        for(const m of src.matchAll(/^#define\s+(VK_\w+)\s+(.+?)\s*$/gm)) pending.push([m[1], m[2].trim()]);
    }
    const value = text => {
        text = text.replace(/\/\/.*$|\/\*.*?\*\//g, "").trim();
        let m;
        if((m = /^\(\(\w+\)\s*(-?\d+)\)$/.exec(text))) return +m[1];
        if((m = /^(-?(?:0x[0-9a-fA-F]+|\d+))U?(?:LL|ULL)?$/.exec(text))) return Number(m[1]);
        if((m = /^\(?(\d+)U?\s*<<\s*(\d+)\)?$/.exec(text))) return m[1] * 2 ** +m[2];
        if(/^VK_\w+$/.test(text)) return constants.get(text);
        if((m = /^0x([0-9a-fA-F]+)ULL$/.exec(text))) return parseInt(m[1], 16);
        return undefined;
    };
    for(let round = 0; round < 3; round++)
    {
        for(const [name, text] of pending)
        {
            if(constants.has(name)) continue;
            const v = value(text);
            if(typeof v === "number" && !Number.isNaN(v)) constants.set(name, v);
        }
    }
    // (64-bit flag bits: `static const VkFlags64 VK_X = 0x...ULL;`)
    for(const src of sources)
    {
        for(const m of src.matchAll(/^static const \w+ (VK_\w+) = (0x[0-9a-fA-F]+)ULL;/gm)) constants.set(m[1], Number(BigInt(m[2])));
    }
}
const constant = name => {
    if(!constants.has(name)) throw new Error("unknown constant " + name);
    return constants.get(name);
};

// ---------------------------------------------------------------------------
// The functions

/** @type {Map<string, {name: string, params: string[], body: string[], file: string}>} */
const functions = new Map();
for(const file of fs.readdirSync(proto_dir).sort())
{
    if(!file.endsWith(".h")) continue;
    const src = fs.readFileSync(path.join(proto_dir, file), "utf8");
    const re = /^(?:static inline [\w *]+?\s*\n|static inline [\w *]+? )(vn_(?:encode|decode)_\w+)\(([^)]*)\)\n\{\n([\s\S]*?)^\}/gm;
    for(const m of src.matchAll(re))
    {
        functions.set(m[1], { name: m[1], params: m[2].split(",").map(s => s.trim()), body: m[3].split("\n"), file });
    }
}

// The primitives (vn_protocol_driver_types.h, _handles.h): what each type
// is on the wire
const BASE = {
    "uint32_t": "u32", "int32_t": "i32", "uint64_t": "u64", "int64_t": "i64", "float": "f32", "double": "f64",
    "uint8_t": "u8", "uint16_t": "u16", "int16_t": "i16", "size_t": "u64",
};
const primitive = new Map(Object.entries(BASE));
const primitive_array = new Map(Object.keys(BASE).map(t => [t, BASE[t]]));
for(const file of ["vn_protocol_driver_types.h", "vn_protocol_driver_handles.h"])
{
    for(const f of functions.values())
    {
        if(f.file !== file || !f.name.startsWith("vn_encode_")) continue;
        const type = f.name.slice("vn_encode_".length);
        const lines = f.body.map(s => s.trim()).filter(s => s && !s.startsWith("/*"));
        if(type.endsWith("_array"))
        {
            const m = lines.length === 1 && /^vn_encode_(\w+)_array\(enc, /.exec(lines[0]);
            if(m && primitive_array.has(m[1])) primitive_array.set(type.slice(0, -6), primitive_array.get(m[1]));
            continue;
        }
        if(BASE[type]) continue;
        if(lines.some(l => l.includes("vn_cs_handle_load_id"))) { primitive.set(type, "h"); continue; }
        const m = lines.length === 1 && /^vn_encode_(\w+)\(enc, /.exec(lines[0]);
        if(m && primitive.has(m[1])) primitive.set(type, primitive.get(m[1]));
    }
}
for(const [type, base] of primitive) if(!primitive_array.has(type) && base !== "h") primitive_array.set(type, base);

// ---------------------------------------------------------------------------
// Statements

/**
 * The body as a tree: {k: "call", fn, args} | {k: "if", cond, then, else} |
 * {k: "for", bound, body} | {k: "switch", expr, cases: [{labels, body}]} |
 * {k: "decl", text} | {k: "assign", text} | {k: "block", body}
 */
function parse(lines, name)
{
    lines = lines.map(l => l.replace(/\/\*.*?\*\//g, "").trim()).filter(l => l);
    let at = 0;
    const statement = () => {
        const line = lines[at++];
        let m;
        if(line === "{")
        {
            return { k: "block", body: block() };
        }
        if((m = /^if \((.*)\)( \{)?$/.exec(line)))
        {
            const node = { k: "if", cond: m[1], then: m[2] ? block() : [statement()], else: null };
            if(lines[at - 1] === "} else {") node.else = block();
            else if(lines[at] === "else") { at++; node.else = [statement()]; }
            return node;
        }
        if((m = /^for \(uint32_t i = 0; i < (.*); i\+\+\)( \{)?$/.exec(line)))
        {
            return { k: "for", bound: m[1], body: m[2] ? block() : [statement()] };
        }
        if((m = /^switch \((.*)\) \{$/.exec(line)))
        {
            const cases = [];
            for(;;)
            {
                const l = lines[at++];
                if(l === "}") break;
                const c = /^case (.*):$/.exec(l);
                if(!c && l !== "default:") throw new Error(name + ": in switch: " + l);
                const labels = c ? [c[1]] : ["default"];
                const body = [];
                while(lines[at] !== "break;") body.push(statement());
                at++;
                cases.push({ labels, body });
            }
            return { k: "switch", expr: m[1], cases };
        }
        if((m = /^(vn_\w+)\((.*)\);$/.exec(line)))
        {
            return { k: "call", fn: m[1], args: split_args(m[2]) };
        }
        if(/^(static )?(const )?[\w ]+ \w+( = .*)?;$/.test(line) && !/^return\b/.test(line)) return { k: "decl", text: line };
        if(/^[\w>\-[\]*.]+ = .*;$/.test(line)) return { k: "assign", text: line };
        if(/^assert\(/.test(line) || line === "return;" || /^return \w+;$/.test(line)) return { k: "skip", text: line };
        throw new Error(name + ": statement: " + line);
    };
    const block = () => {
        const body = [];
        for(;;)
        {
            if(at >= lines.length) throw new Error(name + ": unterminated block");
            if(lines[at] === "}" || lines[at] === "} else {") { at++; return body; }
            body.push(statement());
        }
    };
    const body = [];
    while(at < lines.length) body.push(statement());
    return body;
}

function split_args(text)
{
    const args = [];
    let depth = 0, start = 0;
    for(let i = 0; i < text.length; i++)
    {
        const c = text[i];
        if(c === "(" || c === "{" || c === "[") depth++;
        else if(c === ")" || c === "}" || c === "]") depth--;
        else if(c === "," && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
    }
    args.push(text.slice(start).trim());
    return args;
}

// ---------------------------------------------------------------------------
// Expressions: where a value lives, in the generated JavaScript. Structs are
// objects `o` with the C member names; a command's parameters are an object
// `a` with the C parameter names.

/**
 * An lvalue or rvalue of the C, as JavaScript
 * @param {string} c
 * @param {string} self "o" in a struct's functions, "a" in a command's
 */
function js_value(c, self)
{
    let e = c.trim();
    // (strided arrays: `(void *)pVertexInfo + stride * i`)
    e = e.replace(/^\(void \*\)(\w+) \+ stride \* i$/, "$1[i]");
    // casts, address-of and dereference do not matter here
    e = e.replace(/^\((?:const )?\w+ \*\)/, "");
    while(e.startsWith("&") || e.startsWith("*")) e = e.slice(1);
    if(e === "val") return self;
    e = e.replace(/^val->/, self + ".");
    if(self === "a" && /^[a-zA-Z_]\w*/.test(e) && !e.startsWith("a.")) e = "a." + e;
    return e.replace(/->/g, ".");
}

/** A count or condition of the C, as JavaScript (constants resolved) */
function js_expr(c, self)
{
    let e = c.trim();
    let m;
    if((m = /^\((\w+) \? \*(\w+) : 0\)$/.exec(e)) && m[1] === m[2]) return "(" + js_value(m[1], self) + " || 0)";
    if((m = /^\(?(\w+) \? (\w+)->(\w+) : 0\)?$/.exec(e))) return "(" + js_value(m[1], self) + " ? " + js_value(m[1], self) + "." + m[3] + " : 0)";
    e = e.replace(/\bVK_[A-Z0-9_]+\b/g, name => String(constant(name)));
    // (dereferences: `*pDataSize`, not products)
    e = e.replace(/([(?:,]\s*|^)\*(?=[a-zA-Z_])/g, "$1");
    e = e.replace(/\bval->/g, self + ".");
    e = e.replace(/->/g, ".");
    e = e.replace(/==/g, "===").replace(/!=/g, "!==");
    if(self === "a") e = e.replace(/(^|[^.\w])([a-z][A-Za-z0-9_]*)\b/g, (s, p, id) => p + "a." + id);
    // (C's integer division: `(val->rasterizationSamples + 31) / 32`)
    if(/[^/]\/[^/]/.test(e)) e = "Math.floor(" + e + ")";
    return e;
}

const POINTER = /^(?:val->|)([p]+[A-Z]\w*|[a-z]\w*->p[A-Z]\w*)$/;

// ---------------------------------------------------------------------------
// Requests: the driver's encoders, read back

let code = [];
// (names of the sizes read or written, unique in a function)
let serial = 0;
const emitted_d = new Set(), wanted_d = [];
const want_d = name => { if(!emitted_d.has(name)) { emitted_d.add(name); wanted_d.push(name); } };

/** The decoder of a struct, union or primitive type T read into `target` */
function read_type(type, target, partial, extra_arg)
{
    if(primitive.has(type)) return target + " = r." + primitive.get(type) + "();";
    const fn = "vn_encode_" + type + (partial ? "_partial" : "");
    if(!functions.has(fn)) throw new Error("no " + fn);
    want_d(fn);
    return target + " = " + js_name(fn) + "(r);";
}

function js_name(fn)
{
    // d_ request decoders, e_ reply encoders
    if(fn.startsWith("vn_encode_")) return "d_" + fn.slice("vn_encode_".length);
    if(fn.startsWith("vn_decode_")) return "e_" + fn.slice("vn_decode_".length);
    throw new Error(fn);
}

/**
 * Statements of a driver encoder, as reads
 * @param {Array} body
 * @param {string} self
 * @param {Map<string,string>} counts array sizes read so far (C text -> JS variable)
 * @param {string} indent
 */
function reads(body, self, counts, indent, name)
{
    const out = [];
    const emit = s => out.push(indent + s);
    for(let i = 0; i < body.length; i++)
    {
        const s = body[i];
        if(s.k === "skip") continue;
        if(s.k === "decl")
        {
            let m;
            if(/^const VkCommandTypeEXT cmd_type =/.test(s.text)) continue;
            if((m = /^const size_t string_size = strlen\((.*)\) \+ 1;$/.exec(s.text))) continue;
            if((m = /^static const uint32_t tag = (\d+);/.exec(s.text))) continue;
            throw new Error(name + ": decl " + s.text);
        }
        if(s.k === "call")
        {
            const fn = s.fn;
            let m;
            if(fn === "vn_encode_VkCommandTypeEXT" || (fn === "vn_encode_VkFlags" && s.args[1] === "&cmd_flags")) continue;
            // an output pointer: there or not (`vn_encode_simple_pointer(enc, pApiVersion); /* out */`)
            if(fn === "vn_encode_simple_pointer")
            {
                emit(js_value(s.args[1], self) + " = r.u64() ? 0 : null;");
                continue;
            }
            if(fn === "vn_encode_array_size")
            {
                const v = "n" + (serial++);
                emit("const " + v + " = r.size();");
                counts.set(s.args[1], v);
                continue;
            }
            // a union's tag
            if(s.args[1] === "&tag")
            {
                const base = primitive.get(fn.slice("vn_encode_".length));
                emit("const tag = r." + base + "();");
                continue;
            }
            // the sType of a struct with one
            if(fn === "vn_encode_VkStructureType" && /^&\(VkStructureType\)\{/.test(s.args[1]))
            {
                emit(self + ".sType = r.u32();");
                continue;
            }
            if((m = /^vn_encode_(\w+)_pnext(_partial)?$/.exec(fn)))
            {
                emit(js_value(s.args[1], self) + " = r.pnext(" + (m[2] ? "PNEXT_PARTIAL" : "PNEXT") + ");");
                continue;
            }
            if((m = /^vn_encode_(\w+)_self(_partial)?$/.exec(fn)))
            {
                want_d(fn);
                emit(js_name(fn) + "(r, " + js_value(s.args[1], self) + ");");
                continue;
            }
            // arrays of primitives: (array size read before)
            if((m = /^vn_encode_(\w+)_array$/.exec(fn)) && primitive_array.has(m[1]) || fn === "vn_encode_blob_array" || fn === "vn_encode_char_array")
            {
                const type = fn === "vn_encode_blob_array" ? "blob" : fn === "vn_encode_char_array" ? "char" : m[1];
                const count = counts.get(s.args[2]) || js_expr(s.args[2], self);
                const reader = type === "blob" ? "blob" : type === "char" ? "str" : primitive_array.get(type) + "s";
                emit(js_value(s.args[1], self) + " = r." + reader + "(" + count + ");");
                continue;
            }
            // a ring's id (the transport commands' `uint64_t ring`): the
            // driver's pointer to it, exact (VenusReader.ring_id)
            if(fn === "vn_encode_uint64_t" && s.args[1] === "&ring")
            {
                emit(js_value(s.args[1], self) + " = r.ring_id();");
                continue;
            }
            const type = fn.slice("vn_encode_".length).replace(/_partial$/, "");
            const partial = fn.endsWith("_partial");
            emit(read_type(type, js_value(s.args[1], self), partial));
            continue;
        }
        if(s.k === "if")
        {
            let m;
            // a pointer to one value
            if((m = /^vn_encode_simple_pointer\(enc, (.*)\)$/.exec(s.cond)))
            {
                const target = js_value(m[1], self);
                emit("if(r.u64())");
                emit("{");
                out.push(...reads(s.then, self, counts, indent + "    ", name));
                emit("}");
                emit("else " + target + " = null;");
                continue;
            }
            // a pointer to an array: its size first, in both branches
            const first = list => list.find(x => !(x.k === "decl" && /string_size/.test(x.text)));
            if(POINTER.test(s.cond) && s.else && first(s.then).k === "call" && first(s.then).fn === "vn_encode_array_size")
            {
                const target = js_value(s.cond, self);
                const v = "n" + (serial++);
                emit("const " + v + " = r.size();");
                const size_call = first(s.then);
                counts.set(size_call.args[1], v);
                emit("if(" + v + ")");
                emit("{");
                out.push(...reads(s.then.filter(x => x !== size_call), self, counts, indent + "    ", name));
                emit("}");
                emit("else " + target + " = null;");
                continue;
            }
            // a condition on what was read
            emit("if(" + js_expr(s.cond, self) + ")");
            emit("{");
            out.push(...reads(s.then, self, new Map(counts), indent + "    ", name));
            emit("}");
            if(s.else)
            {
                emit("else");
                emit("{");
                out.push(...reads(s.else, self, new Map(counts), indent + "    ", name));
                emit("}");
            }
            continue;
        }
        if(s.k === "for")
        {
            const count = counts.get(s.bound) || js_expr(s.bound, self);
            // the array: what the body reads at [i]
            const target = array_target(s.body, self);
            emit(target + " = new Array(" + count + ");");
            emit("for(let i = 0; i < " + count + "; i++)");
            emit("{");
            out.push(...reads(s.body, self, new Map(counts), indent + "    ", name));
            emit("}");
            continue;
        }
        if(s.k === "block")
        {
            emit("{");
            out.push(...reads(s.body, self, new Map(counts), indent + "    ", name));
            emit("}");
            continue;
        }
        if(s.k === "switch")
        {
            const tag = s.expr === "tag" ? "tag" : js_expr(s.expr, self);
            emit(self + "._tag = " + tag + ";");
            emit("switch(" + tag + ")");
            emit("{");
            for(const c of s.cases)
            {
                for(const label of c.labels) emit(label === "default" ? "default:" : "case " + js_expr(label, self) + ":");
                if(c.body.length === 1 && c.body[0].k === "skip") { emit("    throw new Error(\"venus: bad union tag \" + tag);"); continue; }
                out.push(...reads(c.body, self, new Map(counts), indent + "    ", name));
                emit("    break;");
            }
            emit("}");
            continue;
        }
        // (`stride = sizeof(...)`: nothing on the wire)
        if(s.k === "assign") continue;
        throw new Error(name + ": " + s.k);
    }
    return out;
}

/** The array that a loop body fills at [i] */
function array_target(body, self)
{
    for(const s of body)
    {
        const args = s.k === "call" ? s.args : s.k === "if" ? [null, /\((.*)\)$/.exec(s.cond)?.[1] || s.cond] : [];
        for(const arg of args.slice(1))
        {
            const m = arg && /^(.*)\[i\]$/.exec(js_value(arg, self));
            if(m) return m[1];
        }
        if(s.k === "block" || s.k === "if")
        {
            const t = array_target(s.k === "block" ? s.body : s.then, self);
            if(t) return t;
        }
    }
    return null;
}

/** Generate a request decoder */
function gen_d(fn)
{
    serial = 0;
    const f = functions.get(fn);
    const tree = parse(f.body, fn);
    if(/_self(_partial)?$/.test(fn))
    {
        code.push("function " + js_name(fn) + "(r, o)", "{", ...reads(tree, "o", new Map(), "    ", fn), "}");
        return;
    }
    if(/^vn_encode_vk\w+$/.test(fn))
    {
        code.push("function " + js_name(fn) + "(r)", "{", "    const a = {};", ...reads(tree, "a", new Map(), "    ", fn), "    return a;", "}");
        return;
    }
    code.push("function " + js_name(fn) + "(r)", "{", "    const o = {};", ...reads(tree, "o", new Map(), "    ", fn), "    return o;", "}");
}

// ---------------------------------------------------------------------------
// Replies: the driver's decoders, written

const emitted_e = new Set(), wanted_e = [];
const want_e = name => { if(!emitted_e.has(name)) { emitted_e.add(name); wanted_e.push(name); } };

function write_type(type, value)
{
    if(primitive.has(type)) return "w." + primitive.get(type) + "(" + value + ");";
    const fn = "vn_decode_" + type;
    if(!functions.has(fn)) throw new Error("no " + fn);
    want_e(fn);
    return js_name(fn) + "(w, " + value + " || EMPTY);";
}

/**
 * Statements of a driver decoder, as writes
 * @param {Map<string,string>} counts sizes written (C variable -> JS expression)
 */
function writes(body, self, counts, indent, name)
{
    const out = [];
    const emit = s => out.push(indent + s);
    for(let i = 0; i < body.length; i++)
    {
        const s = body[i];
        let m;
        if(s.k === "skip") continue;
        if(s.k === "decl")
        {
            if(/^(VkStructureType stype|uint64_t id|VkCommandTypeEXT command_type|\w+ ret|uint32_t tag);$/.test(s.text)) continue;
            if((m = /^const (?:size_t array_size|uint32_t iter_count) = vn_decode_array_size\(dec, (.*)\);$/.exec(s.text)))
            {
                const v = "n" + (serial++);
                const size = js_expr(m[1], self);
                emit("const " + v + " = " + size + ";");
                emit("w.size(" + v + ");");
                counts.set(/^const size_t array_size/.test(s.text) ? "array_size" : "iter_count", v);
                continue;
            }
            throw new Error(name + ": decl " + s.text);
        }
        if(s.k === "assign")
        {
            // (`p = NULL;` in a branch the device takes when it has nothing)
            continue;
        }
        if(s.k === "call")
        {
            const fn = s.fn;
            // the command's type, a struct's sType: what the driver asserts
            if(fn === "vn_decode_VkCommandTypeEXT" || fn === "vn_decode_VkStructureType" && s.args[1] === "&stype")
            {
                const check = body.slice(i + 1).find(x => x.k === "skip" && /^assert\((command_type|stype) == (VK_\w+)\);$/.test(x.text));
                if(!check) throw new Error(name + ": no assert of " + s.args[1]);
                emit("w.u32(" + constant(/(VK_\w+)/.exec(check.text)[1]) + ");");
                continue;
            }
            // what the command returns
            if(s.args[1] === "&ret") { emit("w." + primitive.get(fn.slice("vn_decode_".length)) + "(" + self + ".ret);"); continue; }
            if(fn === "vn_decode_array_size_unchecked") { emit("w.size(0);"); continue; }
            if(fn === "vn_cs_decoder_set_fatal") continue;
            if(s.args[1] === "&tag")
            {
                emit("const tag = " + self + "._tag || 0;");
                emit("w." + primitive.get(fn.slice("vn_decode_".length)) + "(tag);");
                continue;
            }
            if((m = /^vn_decode_(\w+)_pnext$/.exec(fn))) { emit("w.pnext(" + js_value(s.args[1], self) + ", PNEXT_REPLY);"); continue; }
            if((m = /^vn_decode_(\w+)_self$/.exec(fn)))
            {
                want_e(fn);
                emit(js_name(fn) + "(w, " + js_value(s.args[1], self) + ");");
                continue;
            }
            if((m = /^vn_decode_(\w+)_array$/.exec(fn)) && primitive_array.has(m[1]) || fn === "vn_decode_blob_array" || fn === "vn_decode_char_array")
            {
                const type = fn === "vn_decode_blob_array" ? "blob" : fn === "vn_decode_char_array" ? "char" : m[1];
                const count = counts.get(s.args[2]) || js_expr(s.args[2], self);
                const writer = type === "blob" ? "blob" : type === "char" ? "str" : primitive_array.get(type) + "s";
                emit("w." + writer + "(" + js_value(s.args[1], self) + ", " + count + ");");
                continue;
            }
            const type = fn.slice("vn_decode_".length);
            emit(write_type(type, js_value(s.args[1], self)));
            continue;
        }
        if(s.k === "if")
        {
            if(s.cond === "vn_decode_simple_pointer(dec)")
            {
                // the value the branch decodes into
                const target = value_target(s.then, self);
                emit("if(" + target + " != null)");
                emit("{");
                emit("    w.u64(1);");
                out.push(...writes(s.then, self, counts, indent + "    ", name));
                emit("}");
                emit("else w.u64(0);");
                continue;
            }
            if(s.cond === "vn_peek_array_size(dec)")
            {
                const target = array_target_e(s.then, self);
                emit("if(" + target + ")");
                emit("{");
                out.push(...writes(s.then, self, new Map(counts), indent + "    ", name));
                emit("}");
                emit("else w.size(0);");
                continue;
            }
            if(s.cond === "!vn_decode_simple_pointer(dec)") { emit("w.u64(0);"); continue; }
            emit("if(" + js_expr(s.cond, self) + ")");
            emit("{");
            out.push(...writes(s.then, self, new Map(counts), indent + "    ", name));
            emit("}");
            if(s.else)
            {
                emit("else");
                emit("{");
                out.push(...writes(s.else, self, new Map(counts), indent + "    ", name));
                emit("}");
            }
            continue;
        }
        if(s.k === "for")
        {
            const count = counts.get(s.bound) || js_expr(s.bound, self);
            const target = array_target(s.body.map(x => x.k === "call" ? { ...x, fn: x.fn.replace("vn_decode_", "vn_encode_") } : x), self);
            emit("for(let i = 0; i < " + count + "; i++)");
            emit("{");
            if(target) emit("    const " + "item = " + target + " ? " + target + "[i] : undefined;");
            out.push(...writes(s.body, self, new Map(counts), indent + "    ", name).map(l => target ? l.split(target + "[i]").join("item") : l));
            emit("}");
            continue;
        }
        if(s.k === "block")
        {
            emit("{");
            out.push(...writes(s.body, self, new Map(counts), indent + "    ", name));
            emit("}");
            continue;
        }
        if(s.k === "switch")
        {
            emit("switch(tag)");
            emit("{");
            for(const c of s.cases)
            {
                for(const label of c.labels) emit(label === "default" ? "default:" : "case " + js_expr(label, self) + ":");
                if(c.body.length === 1 && c.body[0].k === "call" && c.body[0].fn === "vn_cs_decoder_set_fatal") { emit("    throw new Error(\"venus: bad union tag \" + tag);"); continue; }
                out.push(...writes(c.body, self, new Map(counts), indent + "    ", name));
                emit("    break;");
            }
            emit("}");
            continue;
        }
        throw new Error(name + ": " + s.k);
    }
    return out;
}

function value_target(body, self)
{
    for(const s of body) if(s.k === "call") return js_value(s.args[1], self);
    throw new Error("no value in a pointer branch");
}

function array_target_e(body, self)
{
    for(const s of body)
    {
        if(s.k === "for") for(const x of s.body) if(x.k === "call") return js_value(x.args[1], self).replace(/\[i\]$/, "");
        if(s.k === "call" && s.args.length > 2) return js_value(s.args[1], self);
    }
    throw new Error("no array in an array branch");
}

/** Generate a reply encoder */
function gen_e(fn)
{
    serial = 0;
    const f = functions.get(fn);
    const tree = parse(f.body, fn);
    if(/_self$/.test(fn))
    {
        code.push("function " + js_name(fn) + "(w, o)", "{", ...writes(tree, "o", new Map(), "    ", fn), "}");
        return;
    }
    if(/^vn_decode_vk\w+_reply$/.test(fn))
    {
        code.push("function " + js_name(fn) + "(w, a)", "{", ...writes(tree, "a", new Map(), "    ", fn), "}");
        return;
    }
    code.push("function " + js_name(fn) + "(w, o)", "{", ...writes(tree, "o", new Map(), "    ", fn), "}");
}


// ---------------------------------------------------------------------------
// The driver's side, for tests: g_* encode requests (from the driver's
// encoders), h_* decode replies (from the driver's decoders)

const emitted_g = new Set(), wanted_g = [];
const want_g = name => { if(!emitted_g.has(name)) { emitted_g.add(name); wanted_g.push(name); } };
const guest_name = fn => fn.startsWith("vn_encode_") ? "g_" + fn.slice(10) : "h_" + fn.slice(10);

/** a driver encoder, as writes */
function guest_writes(body, self, indent, name)
{
    const out = [];
    // (elements of arrays the caller left out read as nothing)
    const emit = s => out.push(indent + s.replace(/([\w.]+)\[i\]/g, "($1 || EMPTY)[i]"));
    const sub = (list, more) => guest_writes(list, self, indent + "    ", name);
    for(const s of body)
    {
        let m;
        if(s.k === "skip" || s.k === "assign") continue;
        if(s.k === "decl")
        {
            if((m = /^const VkCommandTypeEXT cmd_type = (VK_\w+);$/.exec(s.text))) continue;
            if((m = /^const size_t string_size = strlen\((.*)\) \+ 1;$/.exec(s.text))) { emit("const string_size = " + js_value(m[1], self) + ".length + 1;"); continue; }
            if((m = /^static const uint32_t tag = (\d+);/.exec(s.text))) { emit("const tag = " + self + "._tag !== undefined ? " + self + "._tag : " + m[1] + ";"); continue; }
            throw new Error(name + ": decl " + s.text);
        }
        if(s.k === "call")
        {
            const fn = s.fn;
            if(fn === "vn_encode_VkCommandTypeEXT")
            {
                emit("w.u32(" + constant("VK_COMMAND_TYPE_" + name.slice("vn_encode_".length) + "_EXT") + ");");
                continue;
            }
            if(fn === "vn_encode_VkFlags" && s.args[1] === "&cmd_flags") { emit("w.u32(a.cmd_flags || 0);"); continue; }
            if(fn === "vn_encode_simple_pointer") { emit("w.u64(" + js_value(s.args[1], self) + " != null ? 1 : 0);"); continue; }
            if(fn === "vn_encode_array_size") { emit("w.size(" + (s.args[1] === "string_size" ? "string_size" : js_expr(s.args[1], self)) + ");"); continue; }
            if(s.args[1] === "&tag") { emit("w." + primitive.get(fn.slice(10)) + "(tag);"); continue; }
            if(fn === "vn_encode_VkStructureType" && (m = /^&\(VkStructureType\)\{ (VK_\w+) \}$/.exec(s.args[1])))
            {
                emit("w.u32(" + constant(m[1]) + ");");
                continue;
            }
            if((m = /^vn_encode_(\w+)_pnext(_partial)?$/.exec(fn))) { emit("w.pnext(" + js_value(s.args[1], self) + ", " + (m[2] ? "GUEST_PNEXT_PARTIAL" : "GUEST_PNEXT") + ");"); continue; }
            if((m = /^vn_encode_(\w+)_self(_partial)?$/.exec(fn))) { want_g(fn); emit(guest_name(fn) + "(w, " + js_value(s.args[1], self) + ");"); continue; }
            if((m = /^vn_encode_(\w+)_array$/.exec(fn)) && primitive_array.has(m[1]) || fn === "vn_encode_blob_array" || fn === "vn_encode_char_array")
            {
                const type = fn === "vn_encode_blob_array" ? "blob" : fn === "vn_encode_char_array" ? "char" : m[1];
                const count = s.args[2] === "string_size" ? "string_size" : js_expr(s.args[2], self);
                const writer = type === "blob" ? "blob" : type === "char" ? "str" : primitive_array.get(type) + "s";
                emit("w." + writer + "(" + js_value(s.args[1], self) + ", " + count + ");");
                continue;
            }
            const type = fn.slice(10);
            if(fn === "vn_encode_uint64_t" && s.args[1] === "&ring") { emit("w.ring_id(" + js_value(s.args[1], self) + ");"); continue; }
            if(primitive.has(type)) { emit("w." + primitive.get(type) + "(" + js_value(s.args[1], self) + ");"); continue; }
            if(!functions.has(fn)) throw new Error("no " + fn);
            want_g(fn);
            const tag = s.args.length > 2 ? ", " + js_expr(s.args[2], self) : "";
            emit(guest_name(fn) + "(w, " + js_value(s.args[1], self) + " || EMPTY" + tag + ");");
            continue;
        }
        if(s.k === "if")
        {
            if((m = /^vn_encode_simple_pointer\(enc, (.*)\)$/.exec(s.cond)))
            {
                emit("if(" + js_value(m[1], self) + " != null)");
                emit("{");
                emit("    w.u64(1);");
                out.push(...sub(s.then));
                emit("}");
                emit("else w.u64(0);");
                continue;
            }
            emit("if(" + (POINTER.test(s.cond) ? js_value(s.cond, self) : js_expr(s.cond, self)) + ")");
            emit("{");
            out.push(...sub(s.then));
            emit("}");
            if(s.else)
            {
                emit("else");
                emit("{");
                out.push(...sub(s.else));
                emit("}");
            }
            continue;
        }
        if(s.k === "for")
        {
            emit("for(let i = 0; i < " + js_expr(s.bound, self) + "; i++)");
            emit("{");
            out.push(...sub(s.body));
            emit("}");
            continue;
        }
        if(s.k === "block") { emit("{"); out.push(...sub(s.body)); emit("}"); continue; }
        if(s.k === "switch")
        {
            emit("switch(tag)");
            emit("{");
            for(const c of s.cases)
            {
                for(const label of c.labels) emit(label === "default" ? "default:" : "case " + js_expr(label, self) + ":");
                if(c.body.length === 1 && c.body[0].k === "skip") { emit("    throw new Error(\"venus: bad union tag \" + tag);"); continue; }
                out.push(...sub(c.body));
                emit("    break;");
            }
            emit("}");
            continue;
        }
        throw new Error(name + ": " + s.k);
    }
    return out;
}

/** a driver decoder, as reads */
function guest_reads(body, self, indent, name)
{
    const out = [];
    const emit = s => out.push(indent + s);
    const sub = list => guest_reads(list, self, indent + "    ", name);
    for(const s of body)
    {
        let m;
        if(s.k === "skip") continue;
        if(s.k === "decl")
        {
            if(/^(VkStructureType stype|uint64_t id|VkCommandTypeEXT command_type|\w+ ret|uint32_t tag);$/.test(s.text)) continue;
            if((m = /^const (?:size_t|uint32_t) (array_size|iter_count) = vn_decode_array_size\(dec, (.*)\);$/.exec(s.text)))
            {
                emit("const " + m[1] + " = r.size();");
                continue;
            }
            throw new Error(name + ": decl " + s.text);
        }
        if(s.k === "assign")
        {
            if((m = /^(.*) = NULL;$/.exec(s.text))) { emit(js_value(m[1], self) + " = null;"); continue; }
            throw new Error(name + ": " + s.text);
        }
        if(s.k === "call")
        {
            const fn = s.fn;
            if(fn === "vn_decode_VkCommandTypeEXT") { emit(self + ".command = r.u32();"); continue; }
            if(s.args[1] === "&ret") { emit(self + ".ret = r." + primitive.get(fn.slice(10)) + "();"); continue; }
            if(fn === "vn_decode_VkStructureType" && s.args[1] === "&stype") { emit(self + ".sType = r.u32();"); continue; }
            if(fn === "vn_decode_array_size_unchecked") { emit("r.size();"); continue; }
            if(fn === "vn_cs_decoder_set_fatal") { emit("throw new Error(\"venus: bad reply\");"); continue; }
            if(s.args[1] === "&tag") { emit("const tag = r." + primitive.get(fn.slice(10)) + "();"); emit(self + "._tag = tag;"); continue; }
            if((m = /^vn_decode_(\w+)_pnext$/.exec(fn))) { emit(js_value(s.args[1], self) + " = r.pnext(GUEST_PNEXT_REPLY);"); continue; }
            if((m = /^vn_decode_(\w+)_self$/.exec(fn))) { want_g(fn); emit(guest_name(fn) + "(r, " + js_value(s.args[1], self) + ");"); continue; }
            if((m = /^vn_decode_(\w+)_array$/.exec(fn)) && primitive_array.has(m[1]) || fn === "vn_decode_blob_array" || fn === "vn_decode_char_array")
            {
                const type = fn === "vn_decode_blob_array" ? "blob" : fn === "vn_decode_char_array" ? "char" : m[1];
                const reader = type === "blob" ? "blob" : type === "char" ? "str" : primitive_array.get(type) + "s";
                emit(js_value(s.args[1], self) + " = r." + reader + "(" + (/^(array_size|iter_count)$/.test(s.args[2]) ? s.args[2] : js_expr(s.args[2], self)) + ");");
                continue;
            }
            const type = fn.slice(10);
            if(primitive.has(type)) { emit(js_value(s.args[1], self) + " = r." + primitive.get(type) + "();"); continue; }
            if(!functions.has(fn)) throw new Error("no " + fn);
            want_g(fn);
            emit(js_value(s.args[1], self) + " = " + guest_name(fn) + "(r);");
            continue;
        }
        if(s.k === "if")
        {
            if(s.cond === "vn_decode_simple_pointer(dec)" || s.cond === "vn_peek_array_size(dec)")
            {
                emit("if(" + (s.cond === "vn_decode_simple_pointer(dec)" ? "r.u64()" : "r.peek_size()") + ")");
                emit("{");
                out.push(...sub(s.then));
                emit("}");
                if(s.else) { emit("else"); emit("{"); out.push(...sub(s.else)); emit("}"); }
                continue;
            }
            emit("if(" + js_expr(s.cond, self) + ")");
            emit("{");
            out.push(...sub(s.then));
            emit("}");
            if(s.else) { emit("else"); emit("{"); out.push(...sub(s.else)); emit("}"); }
            continue;
        }
        if(s.k === "for")
        {
            const count = /^(array_size|iter_count)$/.test(s.bound) ? s.bound : js_expr(s.bound, self);
            const target = array_target(s.body.map(x => x.k === "call" ? { ...x, fn: x.fn.replace("vn_decode_", "vn_encode_") } : x), self);
            if(target) emit(target + " = new Array(" + count + ");");
            emit("for(let i = 0; i < " + count + "; i++)");
            emit("{");
            out.push(...sub(s.body));
            emit("}");
            continue;
        }
        if(s.k === "block") { emit("{"); out.push(...sub(s.body)); emit("}"); continue; }
        if(s.k === "switch")
        {
            emit("switch(tag)");
            emit("{");
            for(const c of s.cases)
            {
                for(const label of c.labels) emit(label === "default" ? "default:" : "case " + js_expr(label, self) + ":");
                if(c.body.length === 1 && c.body[0].k === "call" && c.body[0].fn === "vn_cs_decoder_set_fatal") { emit("    throw new Error(\"venus: bad union tag \" + tag);"); continue; }
                out.push(...sub(c.body));
                emit("    break;");
            }
            emit("}");
            continue;
        }
        throw new Error(name + ": " + s.k);
    }
    return out;
}

function gen_guest(fn)
{
    const f = functions.get(fn);
    const tree = parse(f.body, fn);
    const params = f.params.slice(1);
    // (unions given their tag)
    const tag = params.length > 1 && / tag$/.test(params[params.length - 1]) ? ", tag" : "";
    if(fn.startsWith("vn_encode_"))
    {
        if(/^vn_encode_vk\w+$/.test(fn)) return ["function " + guest_name(fn) + "(w, a)", "{", ...guest_writes(tree, "a", "    ", fn), "}"];
        return ["function " + guest_name(fn) + "(w, o" + tag + ")", "{", ...guest_writes(tree, "o", "    ", fn), "}"];
    }
    if(/_self$/.test(fn)) return ["function " + guest_name(fn) + "(r, o)", "{", ...guest_reads(tree, "o", "    ", fn), "}"];
    if(/^vn_decode_vk\w+_reply$/.test(fn)) return ["function " + guest_name(fn) + "(r)", "{", "    const a = {};", ...guest_reads(tree, "a", "    ", fn), "    return a;", "}"];
    return ["function " + guest_name(fn) + "(r)", "{", "    const o = {};", ...guest_reads(tree, "o", "    ", fn), "    return o;", "}"];
}

// ---------------------------------------------------------------------------
// The commands, the chains

const command_types = new Map();
for(const m of fs.readFileSync(path.join(proto_dir, "vn_protocol_driver_defines.h"), "utf8").matchAll(/VK_COMMAND_TYPE_(vk\w+)_EXT = (\d+),/g))
{
    command_types.set(m[1], +m[2]);
}

// (left out: ray tracing, which WebGPU has nothing for)
const LEFT_OUT = /AccelerationStructure|RayTracing|TraceRays/;
const commands = [];
for(const [name, type] of command_types)
{
    const enc = "vn_encode_" + name;
    if(!functions.has(enc) || LEFT_OUT.test(name)) continue;
    const reply = functions.has("vn_decode_" + name + "_reply") ? "vn_decode_" + name + "_reply" : null;
    want_d(enc);
    if(reply) want_e(reply);
    commands.push({ name, type, enc, reply });
}

// The structs that can be in a chain: those the pnext functions name, with
// their sTypes
const chain_structs = { request: new Map(), partial: new Map(), reply: new Map() };
for(const f of functions.values())
{
    let m;
    if(!(m = /^vn_(encode|decode)_(\w+)_pnext(_partial)?$/.exec(f.name))) continue;
    const src = f.body.join("\n");
    for(const c of src.matchAll(/case (VK_STRUCTURE_TYPE_\w+):[\s\S]*?vn_(?:encode|decode)_(\w+?)_self(_partial)?\(/g))
    {
        const which = m[1] === "decode" ? chain_structs.reply : m[3] ? chain_structs.partial : chain_structs.request;
        which.set(constant(c[1]), c[2]);
    }
}

// generate until nothing more is wanted (the pnext tables pull in theirs)
for(const [stype, struct] of chain_structs.request) want_d("vn_encode_" + struct + "_self");
for(const [stype, struct] of chain_structs.partial) want_d("vn_encode_" + struct + "_self_partial");
for(const [stype, struct] of chain_structs.reply) want_e("vn_decode_" + struct + "_self");
const body = [];
for(let i = 0, j = 0; i < wanted_d.length || j < wanted_e.length;)
{
    code = [];
    if(i < wanted_d.length) gen_d(wanted_d[i++]);
    else gen_e(wanted_e[j++]);
    body.push(...code);
}

// ---------------------------------------------------------------------------
// The module

const header = `// Generated by tools/venus_protocol_gen.mjs from Mesa's venus-protocol
// (src/virtio/venus-protocol, Mesa ${process.env.MESA_VERSION || "26.1.6"}); do not edit.
//
// The Venus wire format: d_* read a request the guest's driver encoded, into
// objects with the C names (structs) or an object of the parameters
// (commands); e_* write a reply the driver decodes, from such objects (what
// is missing is written as zeros, an empty array or a null pointer).

/* eslint-disable */
`;

const tables = [];
tables.push("/** @const {!Object<number, function(!VenusReader, !Object)>} chain structs of requests, by sType */");
tables.push("const PNEXT = {" + [...chain_structs.request].map(([t, s]) => t + ": d_" + s + "_self").join(", ") + "};");
tables.push("/** @const {!Object<number, function(!VenusReader, !Object)>} chain structs of output structs in requests, by sType */");
tables.push("const PNEXT_PARTIAL = {" + [...chain_structs.partial].map(([t, s]) => t + ": d_" + s + "_self_partial").join(", ") + "};");
tables.push("/** @const {!Object<number, function(!VenusWriter, !Object)>} chain structs of replies, by sType */");
tables.push("const PNEXT_REPLY = {" + [...chain_structs.reply].map(([t, s]) => t + ": e_" + s + "_self").join(", ") + "};");
tables.push("const EMPTY = {};");
tables.push("");
tables.push("/** @const {!Object<number, !Array>} command type: [name, request decoder, reply encoder or null] */");
tables.push("export const COMMANDS = {");
for(const c of commands) tables.push("    " + c.type + ": [\"" + c.name + "\", d_" + c.name + ", " + (c.reply ? "e_" + c.name + "_reply" : "null") + "],");
tables.push("};");

// The extensions the protocol knows: name -> [number, spec version]
const extensions = [];
for(const m of fs.readFileSync(path.join(proto_dir, "vn_protocol_driver_info.h"), "utf8").matchAll(/\{ "(VK_\w+)", (\d+), (\d+) \},/g))
{
    extensions.push("    \"" + m[1] + "\": [" + m[2] + ", " + m[3] + "],");
}
tables.push("");
tables.push("/** @const {!Object<string, !Array<number>>} the extensions of the protocol: [number, spec version] */");
tables.push("export const EXTENSIONS = {", ...extensions, "};");
const info = fs.readFileSync(path.join(proto_dir, "vn_protocol_driver_info.h"), "utf8");
tables.push("/** the protocol's Vulkan version (vk.xml) */");
tables.push("export const VK_XML_VERSION = " + (m => (m[1] << 22 | m[2] << 12 | m[3]) >>> 0)(/VK_MAKE_API_VERSION\(0, (\d+), (\d+), (\d+)\)/.exec(info)) + ";");
tables.push("export const WIRE_FORMAT_VERSION = " + /vn_info_wire_format_version\(void\)\n\{\n\s+return (\d+);/.exec(info)[1] + ";");

const runtime = fs.readFileSync(new URL("./venus_protocol_runtime.js", import.meta.url), "utf8");
fs.writeFileSync(out_file, header + "\n" + runtime + "\n" + tables.join("\n") + "\n\n" + body.join("\n") + "\n");
console.log(out_file + ": " + commands.length + " commands, " + emitted_d.size + " decoders, " + emitted_e.size + " encoders, " +
    (fs.statSync(out_file).size >> 10) + " KiB");

if(guest_file)
{
    for(const c of commands) { want_g(c.enc); if(c.reply) want_g(c.reply); }
    for(const [stype, struct] of chain_structs.request) want_g("vn_encode_" + struct + "_self");
    for(const [stype, struct] of chain_structs.partial) want_g("vn_encode_" + struct + "_self_partial");
    for(const [stype, struct] of chain_structs.reply) want_g("vn_decode_" + struct + "_self");
    const guest_body = [];
    for(let i = 0; i < wanted_g.length; i++) guest_body.push(...gen_guest(wanted_g[i]));
    const guest_tables = [
        "import { VenusReader, VenusWriter } from \"" + path.relative(path.dirname(guest_file), out_file).replace(/^(?!\.)/, "./") + "\";",
        "export { VenusReader, VenusWriter };",
        "const EMPTY = {};",
        "const GUEST_PNEXT = {" + [...chain_structs.request].map(([t, s]) => t + ": g_" + s + "_self").join(", ") + "};",
        "const GUEST_PNEXT_PARTIAL = {" + [...chain_structs.partial].map(([t, s]) => t + ": g_" + s + "_self_partial").join(", ") + "};",
        "const GUEST_PNEXT_REPLY = {" + [...chain_structs.reply].map(([t, s]) => t + ": h_" + s + "_self").join(", ") + "};",
        "/** name: [request encoder, reply decoder or null] */",
        "export const GUEST = {",
        ...commands.map(c => "    " + c.name + ": [g_" + c.name + ", " + (c.reply ? "h_" + c.name + "_reply" : "null") + "],"),
        "};",
    ];
    const guest_header = header.replace("The Venus wire format: d_* read", "The driver's side of the Venus wire format, for tests: g_* encode a request,\n// h_* decode a reply (the device's side is venus_protocol.js, where d_* read");
    fs.writeFileSync(guest_file, guest_header + "\n" + guest_tables.join("\n") + "\n\n" + guest_body.join("\n") + "\n");
    console.log(guest_file + ": " + emitted_g.size + " functions, " + (fs.statSync(guest_file).size >> 10) + " KiB");
}
