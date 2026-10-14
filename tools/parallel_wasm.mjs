#!/usr/bin/env node
// Turns the parallel Rust build (linked with --import-memory --emit-relocs)
// into build/v86-parallel.wasm (docs/multicore.md):
//
// - the imported memory becomes shared, with a maximum of 4 GiB;
// - every place that holds an address of the module's static data (code
//   immediates and load/store offsets, pointers inside data segments, the
//   data segment offsets and the __stack_pointer/__data_end/__heap_base
//   globals) is written as a fixed-width field and listed in a custom
//   section "v86.relocs". src/parallel/relocate.js adds a base address to
//   them, which gives each vCPU worker its own copy of the Rust statics, stack
//   and CPU state block inside the one shared memory;
// - the address and size of the CPU state block (the STATE_BLOCK static of
//   cpu/global_pointers.rs) go into the same section, and the fields whose
//   relocation names the STATE_BLOCK symbol are listed apart: relocate.js
//   moves those to a low fixed slot per instance instead (the module is
//   linked above them), so that the generated code reaches the registers
//   with small constant addresses, which hosts like arm64 encode in the load
//   or store itself. (By symbol, not by value: the compiler folds
//   addresses past the end of a static, such as a loop's base, into
//   constants that can fall inside the next static, which may be the state
//   block.)
// - the linker's relocation and linking sections are dropped.
//
// Usage: tools/parallel_wasm.mjs input.wasm output.wasm

import assert from "node:assert/strict";
import fs from "node:fs";

// relocation types (llvm BinaryFormat/WasmRelocs.def)
const R_MEMORY_ADDR_LEB = 3, R_MEMORY_ADDR_SLEB = 4, R_MEMORY_ADDR_I32 = 5;
const HAS_ADDEND = new Set([3, 4, 5, 8, 9, 11, 14, 15, 16, 17, 21, 22, 23, 25]);
const MEMORY_64 = new Set([14, 15, 16, 17, 25]);
const PIC_OR_TLS = new Set([11, 21, 23]);

const SECTION_IMPORT = 2, SECTION_GLOBAL = 6, SECTION_EXPORT = 7, SECTION_CODE = 10, SECTION_DATA = 11;
// (src/parallel/relocate.js) the state block of instance slot k is at k * STATE_SLOT_SIZE
const STATE_SLOTS = 8, STATE_SLOT_SIZE = 4096;

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
        return Number(result);
    }
    name() { const n = this.uleb(); const s = Buffer.from(this.bytes.subarray(this.pos, this.pos + n)).toString("utf8"); this.pos += n; return s; }
}

function uleb(value)
{
    const out = [];
    do { let byte = value % 128; value = Math.floor(value / 128); if(value) byte |= 0x80; out.push(byte); } while(value);
    return out;
}
/** @param {number} value a signed 32-bit value, as a 5-byte padded SLEB */
function sleb5(value)
{
    const out = [];
    let v = value | 0;
    for(let i = 0; i < 5; i++) { out.push(v & 0x7F | (i < 4 ? 0x80 : 0)); v >>= 7; }
    return out;
}
function is_padded_leb(bytes, pos)
{
    return (bytes[pos] & 0x80) && (bytes[pos + 1] & 0x80) && (bytes[pos + 2] & 0x80) && (bytes[pos + 3] & 0x80) && !(bytes[pos + 4] & 0x80);
}

export function convert(input)
{
    const bytes = new Uint8Array(input);
    assert.deepEqual([...bytes.subarray(0, 8)], [0, 0x61, 0x73, 0x6D, 1, 0, 0, 0], "not a wasm module");
    const sections = [];
    for(const r = new Reader(bytes, 8); r.pos < bytes.length;)
    {
        const id = r.u8();
        const size = r.uleb();
        const start = r.pos;
        const section = { id, start, end: start + size, name: null };
        if(id === 0) section.name = new Reader(bytes, start).name();
        sections.push(section);
        r.pos = start + size;
    }

    // relocations, by target section index
    const relocs = new Map();
    for(const s of sections.filter(s => s.name && s.name.startsWith("reloc.")))
    {
        const r = new Reader(bytes, s.start);
        r.name();
        const target = r.uleb();
        const count = r.uleb();
        const list = [];
        for(let i = 0; i < count; i++)
        {
            const type = r.u8();
            const offset = r.uleb();
            const symbol = r.uleb();
            if(HAS_ADDEND.has(type)) r.sleb();
            assert.ok(!MEMORY_64.has(type) && !PIC_OR_TLS.has(type), "unexpected relocation type " + type + " in " + s.name);
            if(type === R_MEMORY_ADDR_LEB || type === R_MEMORY_ADDR_SLEB || type === R_MEMORY_ADDR_I32) list.push({ type, offset, symbol });
        }
        relocs.set(target, (relocs.get(target) || []).concat(list));
    }
    const index_of = id => sections.findIndex(s => s.id === id);

    // the state block: a data symbol of the linking section's symbol table
    // (segment index and offset) and the linked address of its segment
    const state_block = (() => {
        const linking = sections.find(s => s.name === "linking");
        assert.ok(linking, "no linking section: link with --emit-relocs");
        const r = new Reader(bytes, linking.start);
        r.name();
        assert.equal(r.uleb(), 2, "linking section version");
        let symbol = null;
        while(r.pos < linking.end)
        {
            const type = r.u8(), size = r.uleb(), end = r.pos + size;
            if(type === 8) // WASM_SYMBOL_TABLE
            {
                for(let n = r.uleb(), index = 0; n--; index++)
                {
                    const kind = r.u8(), flags = r.uleb();
                    const undefined_symbol = flags & 0x10, explicit_name = flags & 0x40;
                    if(kind === 1) // data
                    {
                        const name = r.name();
                        if(undefined_symbol) continue;
                        const segment = r.uleb(), offset = r.uleb(), length = r.uleb();
                        if(/STATE_BLOCK/.test(name)) { assert.ok(!symbol, "two STATE_BLOCK symbols"); symbol = { segment, offset, length, index }; }
                    }
                    else if(kind === 3) r.uleb(); // section
                    else { r.uleb(); if(!undefined_symbol || explicit_name) r.name(); }
                }
            }
            r.pos = end;
        }
        assert.ok(symbol, "no STATE_BLOCK symbol (build with --features parallel)");
        const data = sections[index_of(SECTION_DATA)];
        const d = new Reader(bytes, data.start);
        const count = d.uleb();
        assert.ok(symbol.segment < count);
        for(let i = 0; i < count; i++)
        {
            assert.equal(d.uleb(), 0);
            assert.equal(d.u8(), 0x41);
            const offset = d.sleb();
            assert.equal(d.u8(), 0x0B);
            const length = d.uleb();
            if(i === symbol.segment) return { address: offset + symbol.offset, size: symbol.length, symbol: symbol.index };
            d.pos += length;
        }
    })();
    assert.equal(state_block.size, STATE_SLOT_SIZE, "STATE_BLOCK size");
    assert.ok(state_block.address >= STATE_SLOTS * STATE_SLOT_SIZE, "the module must be linked above the state slots (--global-base)");
    const code_index = index_of(SECTION_CODE), data_index = index_of(SECTION_DATA);
    assert.ok(relocs.has(code_index), "no reloc.CODE: link with --emit-relocs");
    for(const target of relocs.keys())
    {
        // (relocations of DWARF sections: dropped with them)
        assert.ok(target === code_index || target === data_index || sections[target].name?.startsWith(".debug"), "relocations in section " + target);
    }

    // name of each exported global (the stack pointer is the one mutable i32 global)
    const exported_globals = new Map();
    {
        const s = sections[index_of(SECTION_EXPORT)];
        const r = new Reader(bytes, s.start);
        for(let n = r.uleb(); n--;)
        {
            const name = r.name();
            const kind = r.u8();
            const index = r.uleb();
            if(kind === 3) exported_globals.set(index, name);
        }
    }

    const out = [bytes.subarray(0, 8)];
    let out_length = 8;
    const emit = chunk => { chunk = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk); out.push(chunk); out_length += chunk.length; };
    // (a kind's fields that name the state block: kind + "_state")
    const sites = { uleb5: [], sleb5: [], u32: [], uleb5_state: [], sleb5_state: [], u32_state: [] };
    const state = symbol => symbol === state_block.symbol ? "_state" : "";
    let found_memory = false, globals_relocated = [];

    for(const [index, s] of sections.entries())
    {
        if(s.name && (s.name.startsWith("reloc.") || s.name === "linking" || s.name.startsWith(".debug"))) continue;
        let content = bytes.subarray(s.start, s.end);
        let local_sites = [];

        if(s.id === SECTION_IMPORT)
        {
            const r = new Reader(bytes, s.start);
            const rebuilt = [];
            const n = r.uleb();
            rebuilt.push(...uleb(n));
            for(let i = 0; i < n; i++)
            {
                const from = r.pos;
                const module = r.name(), field = r.name();
                const kind = r.u8();
                if(kind === 2)
                {
                    assert.equal(module + "." + field, "env.memory");
                    const flags = r.u8();
                    const initial = r.uleb();
                    if(flags & 1) r.uleb();
                    rebuilt.push(...uleb(module.length), ...Buffer.from(module), ...uleb(field.length), ...Buffer.from(field), 2, 3, ...uleb(initial), ...uleb(65536));
                    found_memory = true;
                    continue;
                }
                if(kind === 0) r.uleb();
                else if(kind === 1) { r.u8(); const f = r.u8(); r.uleb(); if(f & 1) r.uleb(); }
                else if(kind === 3) { r.u8(); r.u8(); }
                else assert.fail("import kind " + kind);
                rebuilt.push(...bytes.subarray(from, r.pos));
            }
            content = rebuilt;
        }
        else if(s.id === SECTION_GLOBAL)
        {
            const r = new Reader(bytes, s.start);
            const n = r.uleb();
            const rebuilt = [...uleb(n)];
            for(let i = 0; i < n; i++)
            {
                const type = r.u8(), mutable = r.u8();
                const opcode = r.u8();
                assert.equal(opcode, 0x41, "global " + i + ": i32.const initialiser");
                const value = r.sleb();
                assert.equal(r.u8(), 0x0B);
                assert.equal(type, 0x7F);
                const name = exported_globals.get(i) || (mutable ? "__stack_pointer" : null);
                assert.ok(name === "__stack_pointer" || name === "__data_end" || name === "__heap_base", "global " + i + " (" + name + ")");
                globals_relocated.push(name);
                rebuilt.push(type, mutable, 0x41);
                local_sites.push({ kind: "sleb5", pos: rebuilt.length });
                rebuilt.push(...sleb5(value), 0x0B);
            }
            content = rebuilt;
        }
        else if(s.id === SECTION_CODE)
        {
            for(const { type, offset, symbol } of relocs.get(index) || [])
            {
                assert.ok(type !== R_MEMORY_ADDR_I32, "I32 relocation in code");
                assert.ok(is_padded_leb(bytes, s.start + offset), "relocated LEB at code offset " + offset + " is not 5 bytes");
                local_sites.push({ kind: (type === R_MEMORY_ADDR_LEB ? "uleb5" : "sleb5") + state(symbol), pos: offset });
            }
        }
        else if(s.id === SECTION_DATA)
        {
            // Re-encode segment offsets as 5-byte SLEBs and move the data
            // relocations along. With an imported memory the linker writes
            // .bss as zero segments; drop them: the memory of instance 0 is
            // fresh and relocate.js places other instances in zeroed memory.
            const r = new Reader(bytes, s.start);
            const n = r.uleb();
            const data_relocs = relocs.get(index) || [];
            const rebuilt = [];
            let kept = 0;
            const moves = []; // [old content offset of payload, new content offset of payload, length]
            for(let i = 0; i < n; i++)
            {
                const flags = r.uleb();
                assert.equal(flags, 0, "data segment " + i + ": active segments in memory 0 only");
                assert.equal(r.u8(), 0x41);
                const offset = r.sleb();
                assert.equal(r.u8(), 0x0B);
                const length = r.uleb();
                const from = r.pos - s.start;
                if(bytes.subarray(r.pos, r.pos + length).every(b => b === 0) &&
                    !data_relocs.some(({ offset }) => offset >= from && offset < from + length))
                {
                    r.pos += length;
                    continue;
                }
                kept++;
                rebuilt.push(0, 0x41);
                local_sites.push({ kind: "sleb5", pos: rebuilt.length });
                rebuilt.push(...sleb5(offset), 0x0B, ...uleb(length));
                moves.push([r.pos - s.start, rebuilt.length, length]);
                for(let j = 0; j < length; j += 65536) rebuilt.push(...bytes.subarray(r.pos + j, r.pos + Math.min(length, j + 65536)));
                r.pos += length;
            }
            const count = uleb(kept);
            for(const site of local_sites) site.pos += count.length;
            for(const move of moves) move[1] += count.length;
            rebuilt.unshift(...count);
            for(const { type, offset, symbol } of data_relocs)
            {
                assert.equal(type, R_MEMORY_ADDR_I32, "data relocation type " + type);
                const move = moves.find(([from, , length]) => offset >= from && offset + 4 <= from + length);
                assert.ok(move, "data relocation outside the segments");
                local_sites.push({ kind: "u32" + state(symbol), pos: offset - move[0] + move[1] });
            }
            content = rebuilt;
        }

        emit([s.id, ...uleb(content.length)]);
        for(const site of local_sites) sites[site.kind].push(out_length + site.pos);
        emit(content);
    }
    assert.ok(found_memory, "link with --import-memory");
    assert.deepEqual(globals_relocated.sort(), ["__data_end", "__heap_base", "__stack_pointer"]);

    // custom section "v86.relocs" (version 3): for each kind, count and
    // delta-coded positions, first the fields relocated by the instance's
    // base, then those naming the state block; then the state block's
    // linked address and size
    const table = [...uleb(3)];
    for(const kind of ["uleb5", "sleb5", "u32", "uleb5_state", "sleb5_state", "u32_state"])
    {
        const list = sites[kind].sort((a, b) => a - b);
        table.push(...uleb(list.length));
        let last = 0;
        for(const pos of list) { table.push(...uleb(pos - last)); last = pos; }
    }
    table.push(...uleb(state_block.address), ...uleb(state_block.size));
    const name = Buffer.from("v86.relocs");
    const custom = [...uleb(name.length), ...name, ...table];
    emit([0, ...uleb(custom.length)]);
    emit(custom);
    const result = new Uint8Array(out_length);
    let at = 0;
    for(const chunk of out) { result.set(chunk, at); at += chunk.length; }
    return { bytes: result, sites, state_block };
}

if(process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()))
{
    const [input, output] = process.argv.slice(2);
    assert.ok(input && output, "usage: tools/parallel_wasm.mjs input.wasm output.wasm");
    const { bytes, sites, state_block } = convert(fs.readFileSync(input));
    new WebAssembly.Module(bytes);
    fs.writeFileSync(output, bytes);
    console.log(`${output}: ${bytes.length} bytes; relocated fields: ${sites.uleb5.length} offsets, ${sites.sleb5.length} constants, ` +
        `${sites.u32.length} data pointers; of the state block ${sites.uleb5_state.length}, ${sites.sleb5_state.length}, ` +
        `${sites.u32_state.length}; state block at ${state_block.address.toString(16)}`);
}
