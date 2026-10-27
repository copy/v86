// The emugl GLES wire format by the generated layouts (src/gles/gles_protocol.js,
// docs/gles-proxy-plan.md "协议与生成器"): a command's arguments taken out of
// its bytes, its reply put together, and (for tests, and the guest library's
// shape in JS) a command encoded. Values are little-endian; an in or inout
// pointer is its length (u32) and its bytes, an out pointer its length only,
// a DMA pointer an 8-byte guest physical address; the reply is the out and
// inout pointers' bytes in order, then the return value.

import { GLES_APIS } from "./gles_protocol.js";

/** The bytes of each value kind */
export const KIND_BYTES = { "void": 0, "u8": 1, "i16": 2, "u16": 2, "i32": 4, "u32": 4, "f32": 4, "u64": 8, "i64": 8 };

/**
 * A command's description: its API, opcode, name, return kind, parameters, flags
 * @typedef {{api: string, opcode: number, name: string, ret: string, params: !Array<!Array>, flags: !Array<string>}}
 */
export let GLESCommand;

/** @type {!Map<number, !GLESCommand>} */
const BY_OPCODE = new Map();
/** @type {!Map<string, !GLESCommand>} */
const BY_NAME = new Map();
/** @type {!Array<{api: string, first: number, last: number}>} */
export const GLES_RANGES = [];

for(const [api, { base, commands }] of Object.entries(GLES_APIS))
{
    commands.forEach(([name, ret, params, flags], i) =>
    {
        const command = { api, opcode: base + i, name, ret, params, flags: flags || [] };
        BY_OPCODE.set(base + i, command);
        // (GLESv1 and GLESv2 share names: the API's own first, under "api:name" too)
        BY_NAME.set(api + ":" + name, command);
        if(!BY_NAME.has(name)) BY_NAME.set(name, command);
    });
    GLES_RANGES.push({ api, first: base, last: base + commands.length - 1 });
}

/** @param {number} opcode @return {?GLESCommand} */
export function command_of_opcode(opcode) { return BY_OPCODE.get(opcode) || null; }

/** @param {string} name "rcFBPost", "gles2:glDrawArrays" @return {?GLESCommand} */
export function command_of_name(name) { return BY_NAME.get(name) || null; }

/**
 * An out (or inout) pointer's place in the reply: the handler fills data
 * (zeros if it does not)
 * @constructor
 * @param {number} size
 * @param {?Uint8Array} input an inout pointer's bytes
 */
export function OutBuffer(size, input)
{
    this.size = size;
    this.data = new Uint8Array(size);
    if(input) this.data.set(input.subarray(0, size));
    this.view = new DataView(this.data.buffer);
}

/**
 * @param {!DataView} view
 * @param {number} at
 * @param {string} kind
 * @return {number}
 */
function read_value(view, at, kind)
{
    switch(kind)
    {
        case "u8": return view.getUint8(at);
        case "i16": return view.getInt16(at, true);
        case "u16": return view.getUint16(at, true);
        case "i32": return view.getInt32(at, true);
        case "u32": return view.getUint32(at, true);
        case "f32": return view.getFloat32(at, true);
        case "u64": return view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x100000000;
        case "i64": return view.getUint32(at, true) + view.getInt32(at + 4, true) * 0x100000000;
    }
    return 0;
}

/**
 * @param {!DataView} view
 * @param {number} at
 * @param {string} kind
 * @param {number|boolean} value
 */
function write_value(view, at, kind, value)
{
    const v = +value;
    switch(kind)
    {
        case "u8": view.setUint8(at, v); break;
        case "i16": view.setInt16(at, v, true); break;
        case "u16": view.setUint16(at, v, true); break;
        case "i32": view.setInt32(at, v, true); break;
        case "u32": view.setUint32(at, v >>> 0, true); break;
        case "f32": view.setFloat32(at, v, true); break;
        case "u64":
        case "i64":
            view.setUint32(at, v >>> 0, true);
            view.setUint32(at + 4, Math.floor(v / 0x100000000) >>> 0, true);
            break;
    }
}

/**
 * A command's arguments, from its bytes (header included): values as
 * numbers; an in pointer as its bytes (null for a NULL one: length 0 and
 * nullAllowed), an out or inout pointer as an OutBuffer, a DMA pointer as
 * {dma: address}. Throws when the parameters do not fill the command
 * exactly (a layout that disagrees with the guest's encoder)
 * @param {!GLESCommand} command
 * @param {!Uint8Array} bytes
 * @return {!Array<*>}
 */
export function decode_arguments(command, bytes)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const args = [];
    let at = 8;
    for(const [name, kind, dir, flags] of command.params)
    {
        if(kind !== "ptr")
        {
            const n = KIND_BYTES[kind];
            if(at + n > bytes.length) throw new Error(`${command.name}: ${name} is beyond the command's ${bytes.length} bytes`);
            args.push(read_value(view, at, kind));
            at += n;
            continue;
        }
        if(flags && flags.includes("DMA"))
        {
            if(at + 8 > bytes.length) throw new Error(`${command.name}: ${name} is beyond the command's ${bytes.length} bytes`);
            args.push({ dma: read_value(view, at, "u64") });
            at += 8;
            continue;
        }
        if(at + 4 > bytes.length) throw new Error(`${command.name}: ${name}'s length is beyond the command's ${bytes.length} bytes`);
        const size = view.getUint32(at, true);
        at += 4;
        if(dir === "out")
        {
            args.push(new OutBuffer(size, null));
            continue;
        }
        if(at + size > bytes.length) throw new Error(`${command.name}: ${name}'s ${size} bytes are beyond the command's ${bytes.length}`);
        const data = bytes.subarray(at, at + size);
        at += size;
        if(dir === "inout") args.push(new OutBuffer(size, data));
        else args.push(size === 0 && flags && flags.includes("nullAllowed") ? null : data);
    }
    if(at !== bytes.length) throw new Error(`${command.name}: the parameters take ${at} bytes, the command has ${bytes.length}`);
    return args;
}

/**
 * The reply to a command: its out and inout pointers' bytes, then its return value
 * @param {!GLESCommand} command
 * @param {!Array<*>} args decode_arguments's (the handler filled the OutBuffers)
 * @param {number|boolean|undefined} ret
 * @return {?Uint8Array} null when the command has no reply
 */
export function encode_reply(command, args, ret)
{
    let size = KIND_BYTES[command.ret];
    command.params.forEach(([, kind, dir, flags], i) =>
    {
        if(kind === "ptr" && (dir === "out" || dir === "inout") && !(flags && flags.includes("DMA"))) size += args[i].size;
    });
    if(!size) return null;
    const reply = new Uint8Array(size), view = new DataView(reply.buffer);
    let at = 0;
    command.params.forEach(([, kind, dir, flags], i) =>
    {
        if(kind === "ptr" && (dir === "out" || dir === "inout") && !(flags && flags.includes("DMA")))
        {
            reply.set(args[i].data, at);
            at += args[i].size;
        }
    });
    if(command.ret !== "void") write_value(view, at, command.ret, ret === undefined ? 0 : ret);
    return reply;
}

/**
 * Whether a command is answered (the guest waits for the reply)
 * @param {!GLESCommand} command
 * @return {boolean}
 */
export function has_reply(command)
{
    return command.ret !== "void" || command.params.some(([, kind, dir, flags]) =>
        kind === "ptr" && (dir === "out" || dir === "inout") && !(flags && flags.includes("DMA")));
}

/**
 * A command encoded as the guest's encoder would: values as numbers, an in
 * or inout pointer as its bytes (null: a NULL pointer, length 0), an out
 * pointer as its length, a DMA pointer as its address
 * @param {string} name
 * @param {!Array<*>} args
 * @return {!Uint8Array}
 */
export function encode_command(name, args)
{
    const command = command_of_name(name);
    if(!command) throw new Error("no GLES command " + name);
    if(args.length !== command.params.length) throw new Error(`${name} takes ${command.params.length} arguments, got ${args.length}`);
    let size = 8;
    command.params.forEach(([, kind, dir, flags], i) =>
    {
        if(kind !== "ptr") size += KIND_BYTES[kind];
        else if(flags && flags.includes("DMA")) size += 8;
        else size += 4 + (dir === "out" ? 0 : args[i] ? args[i].length : 0);
    });
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    view.setUint32(0, command.opcode, true);
    view.setUint32(4, size, true);
    let at = 8;
    command.params.forEach(([, kind, dir, flags], i) =>
    {
        const value = /** @type {number} */ (args[i]);
        if(kind !== "ptr")
        {
            write_value(view, at, kind, value);
            at += KIND_BYTES[kind];
        }
        else if(flags && flags.includes("DMA"))
        {
            write_value(view, at, "u64", value);
            at += 8;
        }
        else if(dir === "out")
        {
            view.setUint32(at, value >>> 0, true);
            at += 4;
        }
        else
        {
            const data = /** @type {?Uint8Array} */ (args[i]) || new Uint8Array(0);
            view.setUint32(at, data.length, true);
            bytes.set(data, at + 4);
            at += 4 + data.length;
        }
    });
    return bytes;
}

/**
 * A reply read as the guest's encoder reads it: the out and inout pointers'
 * bytes (by their lengths in the command) and the return value
 * @param {string} name
 * @param {!Array<*>} args the command's (out pointers' lengths)
 * @param {!Uint8Array} reply
 * @return {{outs: !Array<!Uint8Array>, ret: number}}
 */
export function decode_reply(name, args, reply)
{
    const command = command_of_name(name);
    const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
    const outs = [];
    let at = 0;
    command.params.forEach(([, kind, dir, flags], i) =>
    {
        if(kind === "ptr" && (dir === "out" || dir === "inout") && !(flags && flags.includes("DMA")))
        {
            const n = dir === "out" ? args[i] : args[i].length;
            outs.push(reply.subarray(at, at + n));
            at += n;
        }
    });
    const ret = command.ret === "void" ? 0 : read_value(view, at, command.ret);
    if(at + KIND_BYTES[command.ret] !== reply.length) throw new Error(`${name}: a reply of ${reply.length} bytes, expected ${at + KIND_BYTES[command.ret]}`);
    return { outs, ret };
}
