#!/usr/bin/env node
// Generates src/gles/gles_protocol.js, the emugl/gfxstream GLES wire format
// (docs/gles-proxy-plan.md "协议与生成器", E1), from the host's spec files of
// the pinned gfxstream (docs/gfxstream-protocol.md: 7e9d595b):
// codegen/{renderControl,gles1,gles2}/<api>.{in,attrib,types}. It reads
// them as emugen does (codegen/generic-apigen: parser.cpp, entry_point.cpp,
// type_factory.cpp):
//
// - a .in line is PREFIX(return type, name, parameters...) (the prefix is
//   not checked: renderControl.in's first line says GL_ENRTY); a command's
//   opcode is the .attrib's base_opcode plus its line's index
// - a type is its tokens joined by spaces, "*" glued on ("GLchar*const*" is
//   "GLchar* const*"); "const T" is T's; a type ending in "*" is a pointer
// - a pointer is "in" unless the .attrib says "dir <name> out|inout";
//   var_flag adds nullAllowed, isLarge, DMA; flag adds unsupported (never
//   sent), custom_decoder, not_api, flushOnEncode
//
// On the wire (api_gen.cpp): opcode and total size (u32 each), then the
// parameters in order: a value by its type's width; an in or inout pointer
// as its byte length (u32) and the bytes, an out pointer as its length only;
// a DMA pointer as an 8-byte guest physical address. The reply: the out and
// inout pointers' bytes in order, then the return value.
//
// usage: node tools/gles/gen.mjs [<gfxstream>/codegen] [out.js]
//   (default build/gles/gfxstream-7e9d595b/codegen, src/gles/gles_protocol.js)

import fs from "node:fs";
import path from "node:path";

const [codegen = "build/gles/gfxstream-7e9d595b/codegen", out_file = "src/gles/gles_protocol.js"] = process.argv.slice(2);
const APIS = [["rc", "renderControl"], ["gles1", "gles1"], ["gles2", "gles2"]];

/** @param {string} text @return {string} emugen's normalized type */
function normalize_type(text)
{
    const tokens = text.match(/\*|[^\s*]+/g) || [];
    return tokens.map((t, i) => i > 0 && t !== "*" ? " " + t : t).join("");
}

/** @param {string} dir @param {string} api @return {!Map<string, {bytes: number, pointer: boolean}>} */
function read_types(dir, api)
{
    const types = new Map([["void", { bytes: 0, pointer: false }], ["char", { bytes: 1, pointer: false }],
        ["int", { bytes: 4, pointer: false }], ["float", { bytes: 4, pointer: false }], ["short", { bytes: 2, pointer: false }],
        ["mat4x4_ptr", { bytes: 64, pointer: true }]]);
    for(const line of fs.readFileSync(path.join(dir, api + ".types"), "utf8").split("\n"))
    {
        const text = line.trim();
        if(!text || text.startsWith("#")) continue;
        const [name, bits] = text.split(/\s+/);
        const type = normalize_type(name);
        if(!types.has(type)) types.set(type, { bytes: +bits + 7 >> 3, pointer: type.endsWith("*") });
    }
    for(const [name, t] of [...types]) types.set("const " + name, t);
    return types;
}

/** The value's kind on the wire, from its C type and width */
function value_kind(type, bytes)
{
    const base = type.replace(/^const /, "");
    if(bytes === 0) return "void";
    if(/^(GLfloat|GLclampf|float)$/.test(base)) return "f32";
    if(bytes === 8) return /^(GLint64)$/.test(base) ? "i64" : "u64";
    if(bytes === 1) return "u8";
    if(bytes === 2) return /^(GLshort|short)$/.test(base) ? "i16" : "u16";
    if(/^(GLint|GLsizei|GLintptr|GLsizeiptr|GLfixed|GLclampx|EGLint|int|GLint32)$/.test(base)) return "i32";
    return "u32";
}

/**
 * @param {string} dir
 * @param {string} api
 * @return {{base: number, commands: !Array<Object>}}
 */
function read_api(dir, api)
{
    const types = read_types(dir, api);
    const commands = [];
    for(const line of fs.readFileSync(path.join(dir, api + ".in"), "utf8").split("\n"))
    {
        const text = line.trim();
        if(!text || text.startsWith("#")) continue;
        const m = /^\w+\s*\((.*)\)\s*;?\s*$/.exec(text);
        if(!m) throw new Error(`${api}.in: cannot read ${text}`);
        const fields = m[1].split(",").map(f => f.trim());
        const [ret, name, ...params] = fields;
        const ret_type = normalize_type(ret);
        if(!types.has(ret_type)) throw new Error(`${api}.in: ${name} returns an unknown type ${ret}`);
        const vars = [];
        for(const [i, p] of params.entries())
        {
            if(p === "void" && params.length === 1) break;
            const tokens = p.match(/\*|[^\s*]+/g);
            const last = tokens[tokens.length - 1];
            const named = tokens.filter(t => t !== "*" && t !== "const").length >= 2 && last !== "*";
            const type = normalize_type(named ? p.slice(0, p.lastIndexOf(last)) : p);
            const var_name = named ? last : "var" + (i + 1);
            const t = types.get(type);
            if(!t) throw new Error(`${api}.in: ${name}'s ${var_name} has an unknown type ${type}`);
            vars.push({ name: var_name, type, bytes: t.bytes, pointer: t.pointer, dir: "in", flags: [], len: type.endsWith("mat4x4_ptr") ? "512" : "" });
        }
        commands.push({ name, ret: ret_type, ret_bytes: types.get(ret_type).bytes, ret_pointer: types.get(ret_type).pointer, vars, flags: [] });
    }
    // the attributes
    let base = 0, current = null;
    for(const line of fs.readFileSync(path.join(dir, api + ".attrib"), "utf8").split("\n"))
    {
        if(!line.trim() || line.trim().startsWith("#")) continue;
        if(!/^\s/.test(line))
        {
            const name = line.trim();
            current = name === "GLOBAL" ? "GLOBAL" : commands.find(c => c.name === name);
            if(!current) throw new Error(`${api}.attrib: no command ${name}`);
            continue;
        }
        const [directive, a, ...rest] = line.trim().split(/\s+/);
        if(current === "GLOBAL")
        {
            if(directive === "base_opcode") base = +a;
            continue;
        }
        const v = current.vars.find(x => x.name === a);
        switch(directive)
        {
            case "flag": current.flags.push(a); break;
            case "dir":
                if(!v || !["in", "out", "inout"].includes(rest[0])) throw new Error(`${api}.attrib: ${current.name}: dir ${a} ${rest[0]}`);
                v.dir = rest[0];
                break;
            case "var_flag":
                if(!v) throw new Error(`${api}.attrib: ${current.name}: var_flag of ${a}`);
                v.flags.push(...rest);
                break;
            case "len":
                if(!v) throw new Error(`${api}.attrib: ${current.name}: len of ${a}`);
                v.len = line.trim().slice(line.trim().indexOf(a) + a.length).trim();
                break;
            // (how the guest packs or the host calls: not the wire's layout)
            case "param_check": case "custom_pack": case "custom_host_pack_tmp_alloc": case "custom_guest_pack":
            case "custom_guest_unpack": case "custom_write": case "custom_host_api": case "custom_host_api_call":
                break;
            default: throw new Error(`${api}.attrib: unknown directive ${directive}`);
        }
    }
    return { base, commands };
}

const header = `// Generated by tools/gles/gen.mjs from gfxstream's host specs
// (codegen/{renderControl,gles1,gles2} at 7e9d595b, docs/gfxstream-protocol.md):
// the emugl GLES wire format (docs/gles-proxy-plan.md). Do not edit.
//
// GLES_APIS[api] = { base, commands }: a command's opcode is base plus its
// index; a command is [name, return, parameters, flags]:
// - return: the value's kind ("void", "u8", "i16", "u16", "i32", "u32",
//   "f32", "u64", "i64"; a pointer's is "u32", it is never sent)
// - parameters: [name, kind, direction, flags] each; kind as above or
//   "ptr" (in, out or inout; flags "nullAllowed", "isLarge", "DMA")
// - flags: "unsupported" (the guest never sends it), "custom_decoder",
//   "not_api", "flushOnEncode"

`;
const lines = [header, "export const GLES_APIS = {"];
const summary = [];
for(const [key, api] of APIS)
{
    const { base, commands } = read_api(path.join(codegen, api), api);
    summary.push(`${key}: ${commands.length} commands from ${base}`);
    lines.push(`    ${key}: { base: ${base}, commands: [`);
    for(const c of commands)
    {
        const ret = c.ret_pointer ? "u32" : value_kind(c.ret, c.ret_bytes);
        const params = c.vars.map(v =>
        {
            const kind = v.pointer ? "ptr" : value_kind(v.type, v.bytes);
            const flags = v.flags.filter(f => ["nullAllowed", "isLarge", "DMA"].includes(f));
            return `[${JSON.stringify(v.name)}, ${JSON.stringify(kind)}` + (v.pointer ? `, ${JSON.stringify(v.dir)}` : "") +
                (flags.length ? `, ${JSON.stringify(flags)}` : "") + "]";
        });
        lines.push(`        [${JSON.stringify(c.name)}, ${JSON.stringify(ret)}, [${params.join(", ")}]` +
            (c.flags.length ? `, ${JSON.stringify(c.flags)}` : "") + "],");
    }
    lines.push("    ] },");
}
lines.push("};", "");
fs.mkdirSync(path.dirname(out_file), { recursive: true });
fs.writeFileSync(out_file, lines.join("\n"));
console.log(`${out_file}: ${summary.join("; ")}`);
