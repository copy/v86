// Loading build/v86-parallel.wasm (docs/multicore.md):
// one shared memory holds several instances of the module, each with its
// own static data, stack and CPU state block at a different base address.
// tools/parallel_wasm.mjs lists every field that holds an address of the
// module's static data; relocate() adds the base to them, except for
// addresses of the CPU state block (the fields whose relocation names it),
// which it moves to the instance's state slot at slot * STATE_SLOT_SIZE,
// below the module's static data: the
// generated code then addresses registers with small constants (which arm64
// hosts encode in the load or store instruction). Slot 0 is the machine
// instance's, so its state block is where v86.wasm has it.

import { dbg_assert } from "../log.js";

export const PAGE_SIZE = 65536;
export const STATE_SLOTS = 8;
export const STATE_SLOT_SIZE = 4096;

function read_uleb(bytes, at)
{
    let result = 0, shift = 0, byte;
    do
    {
        byte = bytes[at.pos++];
        result += (byte & 0x7F) * 2 ** shift;
        shift += 7;
    }
    while(byte & 0x80);
    return result;
}

function sections(bytes)
{
    const list = [];
    const at = { pos: 8 };
    while(at.pos < bytes.length)
    {
        const id = bytes[at.pos++];
        const size = read_uleb(bytes, at);
        const start = at.pos;
        let name = null;
        if(id === 0)
        {
            const length = read_uleb(bytes, at);
            name = String.fromCharCode(...bytes.subarray(at.pos, at.pos + length));
            at.pos += length;
        }
        list.push({ id, start, end: start + size, content: at.pos, name });
        at.pos = start + size;
    }
    return list;
}

/**
 * The memory the module imports as env.memory, or null for the normal build
 * (which defines its own memory)
 * @param {Uint8Array} bytes
 * @return {?{initial: number, maximum: number, shared: boolean}}
 */
export function memory_import(bytes)
{
    const section = sections(bytes).find(s => s.id === 2);
    if(!section) return null;
    const at = { pos: section.start };
    const name = () => {
        const length = read_uleb(bytes, at);
        const text = String.fromCharCode(...bytes.subarray(at.pos, at.pos + length));
        at.pos += length;
        return text;
    };
    for(let count = read_uleb(bytes, at); count--;)
    {
        const module = name(), field = name();
        const kind = bytes[at.pos++];
        if(kind === 0) read_uleb(bytes, at);
        else if(kind === 1) { at.pos++; const flags = bytes[at.pos++]; read_uleb(bytes, at); if(flags & 1) read_uleb(bytes, at); }
        else if(kind === 3) at.pos += 2;
        else if(kind === 2)
        {
            const flags = bytes[at.pos++];
            const initial = read_uleb(bytes, at);
            const maximum = flags & 1 ? read_uleb(bytes, at) : 65536;
            if(module === "env" && field === "memory") return { initial, maximum, shared: !!(flags & 2) };
        }
    }
    return null;
}

/**
 * Positions of the relocated fields and where the linker put the state block
 * @param {Uint8Array} bytes
 * @return {{uleb5: !Array<number>, sleb5: !Array<number>, u32: !Array<number>,
 *     uleb5_state: !Array<number>, sleb5_state: !Array<number>, u32_state: !Array<number>,
 *     state_address: number, state_size: number}}
 */
export function relocations(bytes)
{
    const section = sections(bytes).find(s => s.name === "v86.relocs");
    if(!section) throw new Error("v86-parallel.wasm: no relocation table (not built by tools/parallel_wasm.mjs)");
    const at = { pos: section.content };
    const version = read_uleb(bytes, at);
    if(version !== 3) throw new Error("v86-parallel.wasm: relocation table version " + version + " (rebuild it)");
    const list = () => {
        const positions = [];
        let position = 0;
        for(let count = read_uleb(bytes, at); count--;)
        {
            position += read_uleb(bytes, at);
            positions.push(position);
        }
        return positions;
    };
    const uleb5 = list(), sleb5 = list(), u32 = list();
    const uleb5_state = list(), sleb5_state = list(), u32_state = list();
    const state_address = read_uleb(bytes, at), state_size = read_uleb(bytes, at);
    dbg_assert(at.pos === section.end && state_size === STATE_SLOT_SIZE);
    return { uleb5, sleb5, u32, uleb5_state, sleb5_state, u32_state, state_address, state_size };
}

/**
 * A copy of the module whose static data and stack are at `base` instead of
 * 0 and whose CPU state block is in state slot `slot`. The memory at [base,
 * base + __heap_base) and the slot must be reserved for the instance and
 * zeroed: only non-zero data segments are written.
 * @param {!Uint8Array} bytes
 * @param {number} base a multiple of 64 KiB
 * @param {number} slot 0 for the machine instance, else its vCPU's core number
 * @return {!Uint8Array}
 */
export function relocate(bytes, base, slot)
{
    dbg_assert(base % PAGE_SIZE === 0 && base >= 0 && base < 2 ** 32);
    dbg_assert(slot >= 0 && slot < STATE_SLOTS);
    const table = relocations(bytes);
    const state_start = table.state_address;
    // the new value of a field that holds the (unsigned) address `value`: of
    // the instance's static data, or of its state block (`state`)
    const map = (value, state) => state ? slot * STATE_SLOT_SIZE + value - state_start : value + base;
    const out = new Uint8Array(bytes);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

    const read5 = at => {
        let value = 0;
        for(let i = 0; i < 5; i++) value += (out[at + i] & 0x7F) * 2 ** (7 * i);
        return value; // 35 bits, no sign
    };
    const write5 = (at, value) => {
        for(let i = 0; i < 5; i++)
        {
            out[at + i] = value % 128 | (i < 4 ? 0x80 : 0);
            value = Math.floor(value / 128);
        }
    };
    for(const state of [false, true])
    {
        for(const at of state ? table.uleb5_state : table.uleb5)
        {
            // load/store offsets and unsigned immediates: must stay below 4 GiB
            const value = map(read5(at), state);
            if(value < 0 || value >= 2 ** 32) throw new Error("relocated offset beyond 4 GiB");
            write5(at, value);
        }
        for(const at of state ? table.sleb5_state : table.sleb5)
        {
            // i32.const: a signed 32-bit value in 5 bytes (bits 32..34 are sign extension)
            const value = map(read5(at) % 2 ** 32, state) % 2 ** 32 | 0;
            write5(at, (value >>> 0) + (value < 0 ? 0x700000000 : 0));
        }
        for(const at of state ? table.u32_state : table.u32)
        {
            view.setUint32(at, map(view.getUint32(at, true), state) >>> 0, true);
        }
    }
    return out;
}

/**
 * Instantiate v86.wasm or v86-parallel.wasm. The parallel build imports its
 * memory: this instance (base 0) gets a new shared one.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {!Object} imports with an "env" object
 */
export function instantiate_v86(bytes, imports)
{
    const view = new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
    const memory = memory_import(view);
    if(memory)
    {
        imports["env"]["memory"] = new WebAssembly.Memory({ "initial": memory.initial, "maximum": memory.maximum, "shared": true });
        // (the machine instance: base 0, state slot 0)
        return WebAssembly.instantiate(relocate(view, 0, 0), imports);
    }
    return WebAssembly.instantiate(bytes, imports);
}

/**
 * Bytes an instance occupies at its base: static data, CPU state and stack
 * (__heap_base). Its heap is grown separately, like the one at base 0.
 * @param {Uint8Array} bytes
 */
export function image_size(bytes)
{
    const list = sections(bytes);
    let index = -1;
    {
        const section = list.find(s => s.id === 7);
        const at = { pos: section.start };
        for(let count = read_uleb(bytes, at); count--;)
        {
            const length = read_uleb(bytes, at);
            const name = String.fromCharCode(...bytes.subarray(at.pos, at.pos + length));
            at.pos += length;
            const kind = bytes[at.pos++];
            const i = read_uleb(bytes, at);
            if(kind === 3 && name === "__heap_base") index = i;
        }
    }
    dbg_assert(index >= 0);
    const section = list.find(s => s.id === 6);
    const at = { pos: section.start };
    const count = read_uleb(bytes, at);
    for(let i = 0; i < count; i++)
    {
        at.pos += 2; // type, mutability
        dbg_assert(bytes[at.pos] === 0x41);
        at.pos++;
        let value = 0, shift = 0, byte;
        do { byte = bytes[at.pos++]; value += (byte & 0x7F) * 2 ** shift; shift += 7; } while(byte & 0x80);
        at.pos++; // end
        if(i === index) return value % 2 ** 32;
    }
    dbg_assert(false);
}

/**
 * Another instance of v86-parallel.wasm in `memory`, in freshly grown (so
 * zeroed) pages that nothing else uses
 * @param {!Uint8Array} bytes
 * @param {!Object} imports with an "env" object
 * @param {!WebAssembly.Memory} memory the shared memory of the instance at base 0
 * @param {number} slot its state slot (1..STATE_SLOTS-1, unused by other instances)
 * @return {Promise<{instance: WebAssembly.Instance, base: number}>}
 */
export async function instantiate_relocated(bytes, imports, memory, slot)
{
    const pages = Math.ceil(image_size(bytes) / PAGE_SIZE);
    const base = memory.grow(pages) * PAGE_SIZE;
    imports["env"]["memory"] = memory;
    const { instance } = await WebAssembly.instantiate(relocate(bytes, base, slot), imports);
    return { instance, base };
}
