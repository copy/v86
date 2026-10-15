#!/usr/bin/env node
// Compares two Wasm modules section by section, and their code section
// function by function (docs/arm64-virt-android16-plan.md P0.7,
// docs/jit-unification-plan.md cross-phase rule 12):
//
// - functions are matched by the names of the "name" section: the exact
//   name first, then the name without the hash of a Rust symbol
//   (17h<16 hex digits>E) and LLVM's numeric suffixes (.123) where that is
//   unique, then, among the remaining instances of a generic function, by an
//   equal body;
// - a function whose bytes differ is decoded and compared again with its
//   call targets as names and its type indices as signatures, and, when the
//   static data moved (the data or global sections differ), with constants
//   and memory offsets inside the static data as one placeholder. A function
//   equal that way is "shifted" (an added function renumbers the others'
//   calls; a longer string moves the data after it); else it "changed";
// - a function that moved to another module (its body equal, its symbol's
//   path new) is paired with its old self as "moved", and calls to it count
//   as calls to the old name, so its callers are not "changed" (ARM64 plan
//   P1.0, P1.10: code moves out of the x86 modules);
// - the custom sections (name, producers, target_features, ...) and the data
//   section (the static data, where the panic locations keep file names and
//   line numbers) are reported apart from the code.
//
// Usage: tools/wasm_diff.mjs [--json] [--require-identical] [--fail-on-code] old.wasm new.wasm
//
// Exits with 1 when --require-identical and the files differ, or when
// --fail-on-code and a function changed, was added or removed, or the imports
// or exports differ.

import assert from "node:assert/strict";
import fs from "node:fs";
import url from "node:url";

const SECTION_NAMES = ["custom", "type", "import", "function", "table", "memory", "global", "export",
    "start", "element", "code", "data", "datacount", "tag"];
const SECTION_TYPE = 1, SECTION_IMPORT = 2, SECTION_GLOBAL = 6, SECTION_EXPORT = 7, SECTION_CODE = 10, SECTION_DATA = 11;
const RUST_HASH = /(17h[0-9a-f]{16}E)?(\.\d+)*$/;
const VALUE_TYPES = new Set([0x7F, 0x7E, 0x7D, 0x7C, 0x7B, 0x70, 0x6F]);

class Reader
{
    constructor(bytes, pos = 0) { this.bytes = bytes; this.pos = pos; }
    u8() { return this.bytes[this.pos++]; }
    uleb()
    {
        let result = 0, shift = 0, byte;
        do { byte = this.bytes[this.pos++]; result += (byte & 0x7F) * 2 ** shift; shift += 7; } while(byte & 0x80);
        return result;
    }
    sleb()
    {
        let result = 0n, shift = 0n, byte;
        do { byte = this.bytes[this.pos++]; result |= BigInt(byte & 0x7F) << shift; shift += 7n; } while(byte & 0x80);
        if(byte & 0x40) result -= 1n << shift;
        return result;
    }
    name() { const n = this.uleb(); const s = Buffer.from(this.bytes.subarray(this.pos, this.pos + n)).toString("utf8"); this.pos += n; return s; }
    limits() { const flags = this.uleb(); this.uleb(); if(flags & 1) this.uleb(); }
    // a constant expression: i32.const or i64.const, end
    constant()
    {
        const op = this.u8();
        assert.ok(op === 0x41 || op === 0x42, "constant expression: 0x" + op.toString(16));
        const value = this.sleb();
        assert.equal(this.u8(), 0x0B);
        return Number(value);
    }
    skip(n) { this.pos += n; }
}

/**
 * @param {Uint8Array} bytes
 */
export function parse_module(bytes)
{
    assert.deepEqual([...bytes.subarray(0, 8)], [0, 0x61, 0x73, 0x6D, 1, 0, 0, 0], "not a Wasm module");
    const sections = [];
    const r = new Reader(bytes, 8);
    while(r.pos < bytes.length)
    {
        const id = r.u8(), size = r.uleb(), start = r.pos;
        let name = SECTION_NAMES[id] || "section " + id;
        if(id === 0) name = "custom:" + r.name();
        sections.push({ id, name, start, end: start + size, payload: bytes.subarray(r.pos, start + size) });
        r.pos = start + size;
    }
    const each = id => sections.filter(s => s.id === id);

    const types = [];
    for(const s of each(SECTION_TYPE))
    {
        const t = new Reader(s.payload);
        for(let count = t.uleb(); count--;)
        {
            assert.equal(t.u8(), 0x60, "type: not a function type");
            const params = [], results = [];
            for(let n = t.uleb(); n--;) params.push(t.u8());
            for(let n = t.uleb(); n--;) results.push(t.u8());
            types.push(params.join(",") + "->" + results.join(","));
        }
    }

    let imported_functions = 0, imported_globals = 0;
    for(const s of each(SECTION_IMPORT))
    {
        const i = new Reader(s.payload);
        for(let count = i.uleb(); count--;)
        {
            i.name(); i.name();
            const kind = i.u8();
            if(kind === 0) { imported_functions++; i.uleb(); }
            else if(kind === 1) { i.u8(); i.limits(); }
            else if(kind === 2) i.limits();
            else if(kind === 3) { imported_globals++; i.u8(); i.u8(); }
            else if(kind === 4) { i.u8(); i.uleb(); }
            else throw new Error("import kind " + kind);
        }
    }

    const globals = [];
    for(const s of each(SECTION_GLOBAL))
    {
        const g = new Reader(s.payload);
        for(let count = g.uleb(); count--;) { g.u8(); g.u8(); globals.push(g.constant()); }
    }
    const exported_globals = new Map();
    const exports = [];
    for(const s of each(SECTION_EXPORT))
    {
        const e = new Reader(s.payload);
        for(let count = e.uleb(); count--;)
        {
            const name = e.name(), kind = e.u8(), index = e.uleb();
            if(kind === 3) exported_globals.set(name, globals[index - imported_globals]);
            exports.push({ name, kind, index });
        }
    }

    const names = new Map();
    const name_section = sections.find(s => s.name === "custom:name");
    if(name_section)
    {
        const n = new Reader(name_section.payload);
        n.name();
        while(n.pos < name_section.payload.length)
        {
            const sub = n.u8(), size = n.uleb(), end = n.pos + size;
            if(sub === 1) for(let count = n.uleb(); count--;) { const index = n.uleb(); names.set(index, n.name()); }
            n.pos = end;
        }
    }
    const function_name = index => names.get(index) || "#" + index;

    const functions = [];
    for(const code of each(SECTION_CODE))
    {
        const c = new Reader(code.payload);
        for(let count = c.uleb(), i = 0; i < count; i++)
        {
            const size = c.uleb();
            functions.push({ name: function_name(imported_functions + i), body: code.payload.subarray(c.pos, c.pos + size) });
            c.pos += size;
        }
    }

    const segments = [];
    for(const data of each(SECTION_DATA))
    {
        const d = new Reader(data.payload);
        for(let count = d.uleb(); count--;)
        {
            const flags = d.uleb();
            let address = null;
            if(flags === 0) address = d.constant();
            else if(flags === 2) { d.uleb(); address = d.constant(); }
            const size = d.uleb();
            segments.push({ address, bytes: data.payload.subarray(d.pos, d.pos + size) });
            d.pos += size;
        }
    }

    // the static data: the data segments up to the heap (the stack in between)
    const placed = segments.filter(s => s.address !== null);
    let static_range = null;
    if(placed.length)
    {
        const low = Math.min(...placed.map(s => s.address));
        const high = Math.max(...placed.map(s => s.address + s.bytes.length), exported_globals.get("__heap_base") || 0, globals[0] || 0);
        static_range = [low, high];
    }
    return { sections, types, functions, segments, function_name, static_range, exports };
}

/**
 * A function body as text, with call targets as names, type indices as
 * signatures and, with `range`, constants and memory offsets inside the
 * static data as "addr"
 * @param {Uint8Array} body
 * @param {{types: Array<string>, function_name: function(number): string}} module
 * @param {Array<number>|null} range
 * @param {Map<string, string>=} renamed a moved function's new name (without its hash) -> its old name
 */
export function normalize(body, module, range, renamed)
{
    const r = new Reader(body);
    const out = [];
    const address = value => range && value >= range[0] && value < range[1] ? "addr" : value;
    const callee = index => {
        const name = module.function_name(index).replace(RUST_HASH, "");
        return renamed?.get(name) ?? name;
    };
    const memarg = () => { const align = r.uleb(); if(align & 0x40) out.push("m" + r.uleb()); out.push(align & ~0x40, address(r.uleb())); };
    const block_type = () => {
        if(r.bytes[r.pos] === 0x40 || VALUE_TYPES.has(r.bytes[r.pos])) out.push(r.u8());
        else out.push("type " + module.types[Number(r.sleb())]);
    };

    for(let count = r.uleb(); count--;) out.push(r.uleb(), r.u8());
    while(r.pos < body.length)
    {
        const op = r.u8();
        out.push(op);
        if(op <= 0x01 || op === 0x05 || op === 0x0B || op === 0x0F || op === 0x1A || op === 0x1B || op >= 0x45 && op <= 0xC4 || op === 0xD1)
        {
            continue;
        }
        switch(op)
        {
            case 0x02: case 0x03: case 0x04: block_type(); break;
            case 0x0C: case 0x0D: out.push(r.uleb()); break;
            case 0x0E: for(let n = r.uleb() + 1; n--;) out.push(r.uleb()); break;
            case 0x10: case 0x12: case 0xD2: out.push(callee(r.uleb())); break;
            case 0x11: case 0x13: out.push("type " + module.types[r.uleb()], r.uleb()); break;
            case 0x1C: for(let n = r.uleb(); n--;) out.push(r.u8()); break;
            case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: out.push(r.uleb()); break;
            case 0x3F: case 0x40: out.push(r.uleb()); break;
            case 0x41: out.push(address(Number(r.sleb()))); break;
            case 0x42: out.push(String(r.sleb())); break;
            case 0x43: out.push(...r.bytes.subarray(r.pos, r.pos + 4)); r.skip(4); break;
            case 0x44: out.push(...r.bytes.subarray(r.pos, r.pos + 8)); r.skip(8); break;
            case 0xD0: out.push(r.u8()); break;
            case 0xFC:
            {
                const sub = r.uleb();
                out.push(sub);
                if(sub === 8 || sub === 10 || sub === 12 || sub === 14) out.push(r.uleb(), r.uleb());
                else if(sub === 9 || sub === 11 || sub === 13 || sub >= 15 && sub <= 17) out.push(r.uleb());
                else assert.ok(sub <= 7, "0xFC " + sub);
                break;
            }
            case 0xFD:
            {
                const sub = r.uleb();
                out.push(sub);
                if(sub <= 11 || sub === 92 || sub === 93) memarg();
                else if(sub === 12 || sub === 13) { out.push(...r.bytes.subarray(r.pos, r.pos + 16)); r.skip(16); }
                else if(sub >= 21 && sub <= 34) out.push(r.u8());
                else if(sub >= 84 && sub <= 91) { memarg(); out.push(r.u8()); }
                break;
            }
            case 0xFE:
            {
                const sub = r.uleb();
                out.push(sub);
                if(sub === 0x03) out.push(r.u8());
                else memarg();
                break;
            }
            default:
                if(op >= 0x28 && op <= 0x3E) memarg();
                else throw new Error("unknown opcode 0x" + op.toString(16) + " at " + (r.pos - 1));
        }
    }
    return out.join(" ");
}

function same(a, b)
{
    return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
}

// pairs of [old, new] functions, and the ones left over on each side. Code
// decides before names do: a closure's mangled name names whichever closure
// has its number, so inserting one renames the others (FnOnce::call_once
// with the same hash, other code). In order: the same name and code; the
// same name without the Rust hash and the same code; the same name; the only
// function of its name without the hash on both sides; then a renamed
// function: the same code under another name.
function match_functions(old_functions, new_functions, equal)
{
    const pairs = [];
    const left_old = new Set(old_functions), left_new = new Set(new_functions);
    const pair = (a, b) => { pairs.push([a, b]); left_old.delete(a); left_new.delete(b); };

    const by_name = new Map(new_functions.map(f => [f.name, f]));
    const unique = by_name.size === new_functions.length;
    const same_name = only_equal => {
        if(!unique) return;
        for(const f of [...left_old])
        {
            const g = by_name.get(f.name);
            if(g && left_new.has(g) && (!only_equal || equal(f, g))) pair(f, g);
        }
    };
    const group = functions => {
        const groups = new Map();
        for(const f of functions)
        {
            const key = f.name.replace(RUST_HASH, "");
            if(!groups.has(key)) groups.set(key, []);
            groups.get(key).push(f);
        }
        return groups;
    };

    same_name(true);
    let new_groups = group(left_new);
    for(const [key, olds] of group(left_old))
    {
        const news = new_groups.get(key);
        if(!news) continue;
        for(const f of olds)
        {
            const g = news.find(g => left_new.has(g) && equal(f, g));
            if(g) pair(f, g);
        }
    }
    same_name(false);
    new_groups = group(left_new);
    for(const [key, olds] of group(left_old))
    {
        const news = new_groups.get(key);
        if(olds.length === 1 && news?.length === 1) pair(olds[0], news[0]);
    }
    for(const f of [...left_old])
    {
        const g = [...left_new].find(g => equal(f, g));
        if(g) pair(f, g);
    }
    return { pairs, removed: [...left_old], added: [...left_new] };
}

function diff_bytes(a, b)
{
    const n = Math.min(a.length, b.length);
    const positions = [];
    let count = Math.abs(a.length - b.length);
    for(let i = 0; i < n; i++)
    {
        if(a[i] !== b[i])
        {
            count++;
            if(positions.length < 8) positions.push(i);
        }
    }
    return { count, positions };
}

/**
 * @param {Uint8Array} old_bytes
 * @param {Uint8Array} new_bytes
 */
export function compare(old_bytes, new_bytes)
{
    const result = {
        identical: same(old_bytes, new_bytes),
        size: [old_bytes.length, new_bytes.length],
        sections: [],
        functions: { total: [0, 0], shifted: 0, moved: [], changed: [], added: [], removed: [] },
        data: { segments: [0, 0], changed_bytes: 0, changes: [] },
        custom: [],
        addresses_masked: false,
    };
    if(result.identical) return result;

    const a = parse_module(old_bytes), b = parse_module(new_bytes);
    const keys = [...new Set([...a.sections, ...b.sections].map(s => s.name))];
    for(const name of keys)
    {
        const sa = a.sections.filter(s => s.name === name), sb = b.sections.filter(s => s.name === name);
        const equal = sa.length === sb.length && sa.every((s, i) => same(s.payload, sb[i].payload));
        const sizes = [sa.reduce((n, s) => n + s.payload.length, 0), sb.reduce((n, s) => n + s.payload.length, 0)];
        if(name.startsWith("custom:")) result.custom.push({ name, equal, sizes });
        else result.sections.push({ name, equal, sizes });
    }

    // (the static data moved: compare the addresses into it as placeholders)
    const moved = result.sections.some(s => (s.name === "data" || s.name === "global") && !s.equal);
    result.addresses_masked = moved;
    const normal = new Map();
    const normalized = (f, module) => {
        if(!normal.has(f)) normal.set(f, normalize(f.body, module, moved ? module.static_range : null));
        return normal.get(f);
    };
    const old_set = new Set(a.functions);
    const equal = (f, g) => same(f.body, g.body) || normalized(f, old_set.has(f) ? a : b) === normalized(g, old_set.has(g) ? a : b);

    result.functions.total = [a.functions.length, b.functions.length];
    const { pairs, removed, added } = match_functions(a.functions, b.functions, equal);
    // moved functions: renamed, with calls to them counting as calls to the
    // old name (until no more pair up)
    const strip = f => f.name.replace(RUST_HASH, "");
    const renamed = new Map();
    const range = module => moved ? module.static_range : null;
    for(let grew = true; grew;)
    {
        grew = false;
        for(const [f, g] of pairs)
        {
            if(strip(f) !== strip(g) && !renamed.has(strip(g))) { renamed.set(strip(g), strip(f)); grew = true; }
        }
        for(const f of [...removed])
        {
            const body = normalize(f.body, a, range(a));
            const g = added.find(g => normalize(g.body, b, range(b), renamed) === body);
            if(!g) continue;
            pairs.push([f, g]);
            removed.splice(removed.indexOf(f), 1);
            added.splice(added.indexOf(g), 1);
            grew = true;
        }
    }
    // the exports, by name and what they name (renumbered functions are the same exports)
    const export_list = (module, rename) => module.exports.map(e => e.name + ":" + e.kind + ":" +
        (e.kind === 0 ? (n => rename?.get(n) ?? n)(module.function_name(e.index).replace(RUST_HASH, "")) : e.index)).sort().join("\n");
    result.exports_equal = export_list(a) === export_list(b, renamed);
    for(const [f, g] of pairs)
    {
        if(strip(f) !== strip(g)) result.functions.moved.push({ from: f.name, to: g.name });
        if(same(f.body, g.body)) continue;
        if(normalized(f, a) === normalized(g, b) ||
            renamed.size && normalize(f.body, a, range(a)) === normalize(g.body, b, range(b), renamed)) result.functions.shifted++;
        else result.functions.changed.push({ name: g.name, sizes: [f.body.length, g.body.length] });
    }
    result.functions.added = added.map(f => ({ name: f.name, size: f.body.length }));
    result.functions.removed = removed.map(f => ({ name: f.name, size: f.body.length }));

    result.data.segments = [a.segments.length, b.segments.length];
    for(let i = 0; i < Math.max(a.segments.length, b.segments.length); i++)
    {
        const sa = a.segments[i], sb = b.segments[i];
        if(!sa || !sb)
        {
            result.data.changes.push({ segment: i, address: (sa || sb).address, only_in: sa ? "old" : "new" });
            continue;
        }
        const { count, positions } = diff_bytes(sa.bytes, sb.bytes);
        if(count || sa.address !== sb.address)
        {
            result.data.changed_bytes += count;
            result.data.changes.push({
                segment: i, address: [sa.address, sb.address], sizes: [sa.bytes.length, sb.bytes.length], changed_bytes: count,
                first: positions.map(p => sb.address === null ? p : "0x" + (sb.address + p).toString(16)),
            });
        }
    }
    return result;
}

// a change of the code: a function changed, added or removed, or different
// imports or exports (the type, function, element and global sections follow
// from those, the data section is reported apart)
export function code_changed(result)
{
    const f = result.functions;
    return f.changed.length + f.added.length + f.removed.length > 0 ||
        result.sections.some(s => !s.equal && (s.name === "import" || s.name === "start" || s.name === "memory" || s.name === "table")) ||
        result.sections.some(s => s.name === "export" && !s.equal) && result.exports_equal === false;
}

export function format(result, old_path, new_path)
{
    const lines = [`${old_path}: ${result.size[0]} bytes, ${new_path}: ${result.size[1]} bytes`];
    if(result.identical)
    {
        lines.push("identical");
        return lines.join("\n");
    }
    const f = result.functions;
    for(const s of result.sections)
    {
        let note = s.equal ? "same" : `differs (${s.sizes[0]} -> ${s.sizes[1]} bytes)`;
        if(s.name === "code")
        {
            note = `${f.changed.length} of ${f.total[1]} functions changed, ${f.added.length} added, ${f.removed.length} removed, ` +
                `${f.shifted} only shifted` + (result.addresses_masked ? " (calls and static data addresses)" : " (calls)") +
                (f.moved.length ? `, ${f.moved.length} moved to another module` : "");
        }
        if(s.name === "data") note = s.equal ? "same" : `${result.data.changed_bytes} bytes differ in ${result.data.changes.length} of ${result.data.segments[1]} segments`;
        lines.push(`  ${s.name.padEnd(10)} ${note}`);
    }
    for(const s of result.custom)
    {
        lines.push(`  ${s.name.padEnd(10)} ${s.equal ? "same" : `differs (${s.sizes[0]} -> ${s.sizes[1]} bytes)`}`);
    }
    for(const c of f.moved) lines.push(`  moved    ${c.from.replace(RUST_HASH, "")} -> ${c.to.replace(RUST_HASH, "")}`);
    for(const c of f.changed) lines.push(`  changed  ${c.name} (${c.sizes[0]} -> ${c.sizes[1]} bytes)`);
    for(const c of f.added) lines.push(`  added    ${c.name} (${c.size} bytes)`);
    for(const c of f.removed) lines.push(`  removed  ${c.name} (${c.size} bytes)`);
    for(const c of result.data.changes)
    {
        lines.push(c.only_in ? `  data segment ${c.segment} only in the ${c.only_in} module` :
            `  data segment ${c.segment}: ${c.changed_bytes} bytes differ, first at ${c.first.join(", ")}`);
    }
    lines.push(code_changed(result) ? "code differs" : "code identical (data or custom sections differ)");
    return lines.join("\n");
}

if(process.argv[1] && url.fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]))
{
    const args = process.argv.slice(2);
    const flag = name => { const i = args.indexOf(name); if(i >= 0) args.splice(i, 1); return i >= 0; };
    const json = flag("--json"), require_identical = flag("--require-identical"), fail_on_code = flag("--fail-on-code");
    if(args.length !== 2)
    {
        console.error("usage: tools/wasm_diff.mjs [--json] [--require-identical] [--fail-on-code] old.wasm new.wasm");
        process.exit(2);
    }
    const result = compare(fs.readFileSync(args[0]), fs.readFileSync(args[1]));
    console.log(json ? JSON.stringify(result, null, 1) : format(result, args[0], args[1]));
    if(require_identical && !result.identical || fail_on_code && code_changed(result)) process.exit(1);
}
