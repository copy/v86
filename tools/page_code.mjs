#!/usr/bin/env node
// The code of a page function (docs/profiling.md): records what the x64 page
// tier (or, with --isa i686, Tier-0; with --isa compat32 the i686 build in
// compatibility mode, compiled by the page tier with x64_page_compat32; with
// --isa legacy32 the i686 build in legacy protected mode, compiled by the
// page tier with x64_page_legacy32)
// compiles while a benchmark runs on a
// test core (ir-test-hooks: build/v86-ir-test-release.wasm), takes the last
// record whose page holds the given instruction bytes, replays it
// (tools/replay_check.mjs' fixed pseudo addresses) and prints the module's
// Wasm, or with --machine the ARM64/x64 code V8's optimizing compiler makes
// of it (node --no-liftoff --print-wasm-code). How the page tier's code for
// M5 was compared with Tier-0's (docs/jit-unification-plan.md, appendix C).
//
// Usage: node tools/page_code.mjs <benchmark> <hex bytes> [--isa x86_64|i686|compat32|legacy32]
//        [--switches name=value,...] [--machine] [--save module.wasm]
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import os from "node:os";
import { spawnSync } from "node:child_process";
const MVP = `unreachable nop block loop if else - - - - - end br br_if br_table return call call_indirect return_call return_call_indirect - - - - - - drop select select_t - - - local.get local.set local.tee global.get global.set table.get table.set - i32.load i64.load f32.load f64.load i32.load8_s i32.load8_u i32.load16_s i32.load16_u i64.load8_s i64.load8_u i64.load16_s i64.load16_u i64.load32_s i64.load32_u i32.store i64.store f32.store f64.store i32.store8 i32.store16 i64.store8 i64.store16 i64.store32 memory.size memory.grow i32.const i64.const f32.const f64.const i32.eqz i32.eq i32.ne i32.lt_s i32.lt_u i32.gt_s i32.gt_u i32.le_s i32.le_u i32.ge_s i32.ge_u i64.eqz i64.eq i64.ne i64.lt_s i64.lt_u i64.gt_s i64.gt_u i64.le_s i64.le_u i64.ge_s i64.ge_u f32.eq f32.ne f32.lt f32.gt f32.le f32.ge f64.eq f64.ne f64.lt f64.gt f64.le f64.ge i32.clz i32.ctz i32.popcnt i32.add i32.sub i32.mul i32.div_s i32.div_u i32.rem_s i32.rem_u i32.and i32.or i32.xor i32.shl i32.shr_s i32.shr_u i32.rotl i32.rotr i64.clz i64.ctz i64.popcnt i64.add i64.sub i64.mul i64.div_s i64.div_u i64.rem_s i64.rem_u i64.and i64.or i64.xor i64.shl i64.shr_s i64.shr_u i64.rotl i64.rotr f32.abs f32.neg f32.ceil f32.floor f32.trunc f32.nearest f32.sqrt f32.add f32.sub f32.mul f32.div f32.min f32.max f32.copysign f64.abs f64.neg f64.ceil f64.floor f64.trunc f64.nearest f64.sqrt f64.add f64.sub f64.mul f64.div f64.min f64.max f64.copysign i32.wrap_i64 i32.trunc_f32_s i32.trunc_f32_u i32.trunc_f64_s i32.trunc_f64_u i64.extend_i32_s i64.extend_i32_u i64.trunc_f32_s i64.trunc_f32_u i64.trunc_f64_s i64.trunc_f64_u f32.convert_i32_s f32.convert_i32_u f32.convert_i64_s f32.convert_i64_u f32.demote_f64 f64.convert_i32_s f64.convert_i32_u f64.convert_i64_s f64.convert_i64_u f64.promote_f32 i32.reinterpret_f32 i64.reinterpret_f64 f32.reinterpret_i32 f64.reinterpret_i64 i32.extend8_s i32.extend16_s i64.extend8_s i64.extend16_s i64.extend32_s`.split(" ");
const SIMD = { 0x00: "v128.load", 0x0B: "v128.store", 0x0C: "v128.const", 0x0D: "i8x16.shuffle", 0x0E: "i8x16.swizzle", 0x0F: "i8x16.splat", 0x10: "i16x8.splat", 0x11: "i32x4.splat", 0x12: "i64x2.splat", 0x13: "f32x4.splat", 0x14: "f64x2.splat",
    0x15: "i8x16.extract_lane_s", 0x16: "i8x16.extract_lane_u", 0x17: "i8x16.replace_lane", 0x18: "i16x8.extract_lane_s", 0x19: "i16x8.extract_lane_u", 0x1A: "i16x8.replace_lane", 0x1B: "i32x4.extract_lane", 0x1C: "i32x4.replace_lane", 0x1D: "i64x2.extract_lane", 0x1E: "i64x2.replace_lane", 0x1F: "f32x4.extract_lane", 0x20: "f32x4.replace_lane", 0x21: "f64x2.extract_lane", 0x22: "f64x2.replace_lane",
    0x4D: "v128.not", 0x4E: "v128.and", 0x4F: "v128.andnot", 0x50: "v128.or", 0x51: "v128.xor", 0x52: "v128.bitselect", 0x53: "v128.any_true", 0x5C: "v128.load32_zero", 0x5D: "v128.load64_zero",
    0x5E: "f32x4.demote_f64x2_zero", 0x5F: "f64x2.promote_low_f32x4", 0x63: "i8x16.all_true", 0x64: "i8x16.bitmask", 0x65: "i8x16.narrow_i16x8_s", 0x66: "i8x16.narrow_i16x8_u", 0x6B: "i8x16.shl", 0x6C: "i8x16.shr_s", 0x6D: "i8x16.shr_u", 0x6E: "i8x16.add", 0x6F: "i8x16.add_sat_s", 0x70: "i8x16.add_sat_u", 0x71: "i8x16.sub", 0x72: "i8x16.sub_sat_s", 0x73: "i8x16.sub_sat_u", 0x76: "i8x16.min_s", 0x77: "i8x16.min_u", 0x78: "i8x16.max_s", 0x79: "i8x16.max_u", 0x7B: "i8x16.avgr_u",
    0x7C: "i16x8.extadd_pairwise_i8x16_s", 0x7D: "i16x8.extadd_pairwise_i8x16_u", 0x7E: "i32x4.extadd_pairwise_i16x8_s", 0x7F: "i32x4.extadd_pairwise_i16x8_u", 0x80: "i16x8.abs", 0x81: "i16x8.neg", 0x85: "i16x8.narrow_i32x4_s", 0x86: "i16x8.narrow_i32x4_u", 0x87: "i16x8.extend_low_i8x16_s", 0x88: "i16x8.extend_high_i8x16_s", 0x89: "i16x8.extend_low_i8x16_u", 0x8A: "i16x8.extend_high_i8x16_u", 0x8B: "i16x8.shl", 0x8C: "i16x8.shr_s", 0x8D: "i16x8.shr_u", 0x8E: "i16x8.add", 0x8F: "i16x8.add_sat_s", 0x90: "i16x8.add_sat_u", 0x91: "i16x8.sub", 0x95: "i16x8.mul", 0x9B: "i16x8.avgr_u",
    0xA0: "i32x4.abs", 0xA1: "i32x4.neg", 0xA3: "i32x4.all_true", 0xA4: "i32x4.bitmask", 0xA7: "i32x4.extend_low_i16x8_s", 0xA8: "i32x4.extend_high_i16x8_s", 0xA9: "i32x4.extend_low_i16x8_u", 0xAA: "i32x4.extend_high_i16x8_u", 0xAB: "i32x4.shl", 0xAC: "i32x4.shr_s", 0xAD: "i32x4.shr_u", 0xAE: "i32x4.add", 0xB1: "i32x4.sub", 0xB5: "i32x4.mul", 0xB6: "i32x4.min_s", 0xB7: "i32x4.min_u", 0xB8: "i32x4.max_s", 0xB9: "i32x4.max_u", 0xBA: "i32x4.dot_i16x8_s",
    0xC0: "i64x2.abs", 0xC1: "i64x2.neg", 0xC3: "i64x2.all_true", 0xC4: "i64x2.bitmask", 0xCB: "i64x2.shl", 0xCC: "i64x2.shr_s", 0xCD: "i64x2.shr_u", 0xCE: "i64x2.add", 0xD1: "i64x2.sub", 0xD5: "i64x2.mul",
    0x23: "i8x16.eq", 0x24: "i8x16.ne", 0x2D: "i16x8.eq", 0x37: "i32x4.eq", 0x38: "i32x4.ne", 0x39: "i32x4.lt_s", 0x3A: "i32x4.lt_u", 0x3B: "i32x4.gt_s", 0x3C: "i32x4.gt_u", 0x3D: "i32x4.le_s", 0x3E: "i32x4.le_u", 0x41: "f32x4.eq", 0x42: "f32x4.ne", 0x43: "f32x4.lt", 0x44: "f32x4.gt", 0x45: "f32x4.le", 0x46: "f32x4.ge", 0x47: "f64x2.eq", 0x48: "f64x2.ne", 0x49: "f64x2.lt", 0x4A: "f64x2.gt", 0x4B: "f64x2.le", 0x4C: "f64x2.ge",
    0xE0: "f32x4.abs", 0xE1: "f32x4.neg", 0xE3: "f32x4.sqrt", 0xE4: "f32x4.add", 0xE5: "f32x4.sub", 0xE6: "f32x4.mul", 0xE7: "f32x4.div", 0xE8: "f32x4.min", 0xE9: "f32x4.max", 0xEC: "f64x2.abs", 0xED: "f64x2.neg", 0xEF: "f64x2.sqrt", 0xF0: "f64x2.add", 0xF1: "f64x2.sub", 0xF2: "f64x2.mul", 0xF3: "f64x2.div", 0xF4: "f64x2.min", 0xF5: "f64x2.max" };
export function disassemble(bytes, { imports = true } = {})
{
    let p = 8;
    const out = [];
    const u = () => { let r = 0, s = 0, b; do { b = bytes[p++]; r |= (b & 0x7F) << s; s += 7; } while(b & 0x80); return r >>> 0; };
    const sleb = () => { let r = 0n, s = 0n, b; do { b = bytes[p++]; r |= BigInt(b & 0x7F) << s; s += 7n; } while(b & 0x80); if(b & 0x40) r -= 1n << s; return r; };
    const name = () => { const n = u(); const t = Buffer.from(bytes.subarray(p, p + n)).toString(); p += n; return t; };
    const import_names = [];
    while(p < bytes.length)
    {
        const id = bytes[p++], size = u(), end = p + size;
        if(id === 2)
        {
            for(let n = u(); n--;)
            {
                const m = name(), f = name(), kind = bytes[p++];
                if(kind === 0) { u(); import_names.push(f); }
                else if(kind === 1) { p++; const fl = u(); u(); if(fl & 1) u(); }
                else if(kind === 2) { const fl = u(); u(); if(fl & 1) u(); }
                else if(kind === 3) { p += 2; }
            }
        }
        if(id === 10)
        {
            for(let fn = 0, count = u(); fn < count; fn++)
            {
                const body_size = u(), body_end = p + body_size;
                const locals = [];
                for(let n = u(); n--;) locals.push(`${u()}x${bytes[p++].toString(16)}`);
                out.push(`;; function ${fn} (${body_size} bytes), locals ${locals.join(" ")}`);
                let depth = 1;
                while(p < body_end)
                {
                    const at = p, o = bytes[p++];
                    let text;
                    const memarg = () => { const a = u(), off = u(); return `align=${a} offset=${off}`; };
                    if(o === 0xFD)
                    {
                        const s = u();
                        const n = SIMD[s] || `simd.0x${s.toString(16)}`;
                        if(s <= 0x0B || s === 0x5C || s === 0x5D) text = `${n} ${memarg()}`;
                        else if(s === 0x0C || s === 0x0D) { text = `${n} ${Array.from(bytes.subarray(p, p + 16)).join(",")}`; p += 16; }
                        else if(s >= 0x15 && s <= 0x22) text = `${n} ${bytes[p++]}`;
                        else if(s >= 0x54 && s <= 0x5B) { text = `${n} ${memarg()} lane ${bytes[p++]}`; }
                        else text = n;
                    }
                    else if(o === 0xFC) { const s = u(); text = `misc.${s}`; if(s === 10) p += 2; else if(s === 11) p += 1; else if(s === 8) { u(); p++; } else if(s === 9) u(); }
                    else if(o === 0xFE) { const s = u(); text = `atomic.0x${s.toString(16)}`; if(s === 3) p++; else text += " " + memarg(); }
                    else if(o >= 0x28 && o <= 0x3E) text = `${MVP[o]} ${memarg()}`;
                    else if(o === 0x3F || o === 0x40) { text = MVP[o]; p++; }
                    else if(o === 0x41 || o === 0x42) { const v = sleb(); text = `${MVP[o]} ${v} (0x${(v < 0n ? (o === 0x41 ? v + (1n << 32n) : v + (1n << 64n)) : v).toString(16)})`; }
                    else if(o === 0x43) { text = `f32.const ${new DataView(bytes.buffer, bytes.byteOffset + p, 4).getFloat32(0, true)}`; p += 4; }
                    else if(o === 0x44) { text = `f64.const ${new DataView(bytes.buffer, bytes.byteOffset + p, 8).getFloat64(0, true)}`; p += 8; }
                    else if(o === 0x02 || o === 0x03 || o === 0x04) { const bt = bytes[p]; if(bt === 0x40 || bt >= 0x7B) p++; else sleb(); text = `${MVP[o]}${bt === 0x40 ? "" : " (result 0x" + bt.toString(16) + ")"}`; }
                    else if(o === 0x0C || o === 0x0D) text = `${MVP[o]} ${u()}`;
                    else if(o === 0x0E) { const n = u(), ls = []; for(let i = 0; i <= n; i++) ls.push(u()); text = `br_table [${ls.slice(0, 12).join(",")}${ls.length > 12 ? ",..." : ""}] (${n + 1})`; }
                    else if(o === 0x10 || o === 0x12) { const f = u(); text = `${MVP[o]} ${f < import_names.length ? import_names[f] : f}`; }
                    else if(o === 0x11 || o === 0x13) { text = `${MVP[o]} type ${u()} table ${u()}`; }
                    else if(o >= 0x20 && o <= 0x24) text = `${MVP[o]} ${u()}`;
                    else if(o === 0x1C) { const n = u(); p += n; text = "select_t"; }
                    else text = MVP[o] || `op.0x${o.toString(16)}`;
                    if(o === 0x0B || o === 0x05) depth--;
                    out.push(`${at.toString(16).padStart(6)} ${"  ".repeat(Math.max(depth, 0))}${text}`);
                    if(o === 0x02 || o === 0x03 || o === 0x04 || o === 0x05) depth++;
                }
                p = body_end;
            }
        }
        p = end;
    }
    return out.join("\n");
}

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf("--" + name); return i < 0 ? fallback : args[i + 1]; };
const [name, hex] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(isa|switches|save)$/));
if(!name || !hex)
{
    console.error("usage: node tools/page_code.mjs <benchmark> <hex bytes> [--isa x86_64|i686|compat32|legacy32] [--switches a=1,...] [--machine] [--save file]");
    process.exit(2);
}
const legacy = option("isa", "x86_64") === "legacy32";
const isa = legacy ? "i686" : option("isa", "x86_64");
const prefix = isa === "i686" && !legacy ? "ir_t0_" : "x64_page_";
process.chdir(ROOT);
const { load_pe, boot_images, create, execute } = await import("../tests/bench/machine.mjs");
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const bench = manifest.benchmarks.find(b => b.name === name);
if(!bench) throw new Error(`no benchmark ${name}`);
const switches = Object.fromEntries(option("switches", "").split(",").filter(Boolean).map(kv => { const [k, v] = kv.split("="); return [k, +v]; }));
if(isa === "compat32" && switches.x64_page_compat32 === undefined) switches.x64_page_compat32 = 1;
if(legacy && switches.x64_page_legacy32 === undefined) switches.x64_page_legacy32 = 1;
const machine = await create({ label: "code", isa, wasm: "build/v86-ir-test-release.wasm", switches }, bench, boot_images(manifest));
const e = machine.e;
if(!e[prefix + "record_start"]) throw new Error("build/v86-ir-test-release.wasm has no replay hooks (ir-test-hooks)");
e[prefix + "record_start"]();
for(let run = 0; run < 2; run++) await execute(machine, load_pe(isa === "x86_64" ? bench.image64 : bench.image), Math.max(1, Math.round(bench.iterations / 8)));
const needle = Uint8Array.from(hex.replace(/\s+/g, "").match(/../g).map(h => parseInt(h, 16)));
const holds = record => { outer: for(let i = 0; i + needle.length <= record.length; i++) { for(let j = 0; j < needle.length; j++) if(record[i + j] !== needle[j]) continue outer; return true; } return false; };
let module;
for(let i = 0, n = e[prefix + "record_count"](); i < n; i++)
{
    const record = new Uint8Array(e.memory.buffer, e[prefix + "record_address"](i), e[prefix + "record_length"](i)).slice();
    if(!holds(record)) continue;
    new Uint8Array(e.memory.buffer, e[prefix + "replay_input"](record.length), record.length).set(record);
    const length = e[prefix + "replay"]();
    module = new Uint8Array(e.memory.buffer, e[prefix + "replay_output"](), length).slice();
}
e[prefix + "record_stop"]();
await machine.vm.destroy();
if(!module) throw new Error("no compiled page holds those bytes");
const save = option("save", path.join(os.tmpdir(), `page-code-${process.pid}.wasm`));
fs.writeFileSync(save, module);
if(args.includes("--machine"))
{
    const compile = spawnSync(process.execPath, ["--no-liftoff", "--no-wasm-lazy-compilation", "--print-wasm-code", "-e",
        `new WebAssembly.Module(require("fs").readFileSync(${JSON.stringify(save)}))`], { encoding: "utf8", maxBuffer: 1 << 28 });
    process.stdout.write(compile.stdout);
}
else
{
    console.log(`;; ${module.length} bytes (${save})`);
    console.log(disassemble(module));
}
