// GLES batches (docs/gles-proxy-plan.md "渲染器通道", E2): what the GLES
// host sends the page, written with GX's writer (GXWriter, GLES_MAGIC:
// src/graphics_adapters/renderer_protocol.js has the records) and read
// back here: by the page's executor (E3) and by the tools that look at a
// recorded boot (tools/gles/batches.mjs).

import { GLES, GLES_MAGIC } from "../graphics_adapters/renderer_protocol.js";
import { command_of_opcode, decode_arguments } from "./gles_wire.js";

/** Each record's dwords, by name (gles_host.js writes them so) */
export const GLES_FIELDS = {
    COMMAND: ["conn", "ret", "length"],
    CONTEXT_CREATE: ["context", "config", "share", "api"],
    CONTEXT_DESTROY: ["context"],
    SURFACE_CREATE: ["surface", "config", "width", "height"],
    SURFACE_DESTROY: ["surface"],
    SURFACE_COLOR_BUFFER: ["surface", "color_buffer"],
    MAKE_CURRENT: ["conn", "context", "draw", "read"],
    COLOR_BUFFER_CREATE: ["color_buffer", "width", "height", "format"],
    COLOR_BUFFER_DESTROY: ["color_buffer"],
    COLOR_BUFFER_UPDATE: ["color_buffer", "x", "y", "width", "height", "format", "type", "length"],
    COLOR_BUFFER_READ: ["color_buffer", "x", "y", "width", "height", "format", "type", "request"],
    COLOR_BUFFER_BIND: ["conn", "color_buffer", "texture"],
    IMAGE_CREATE: ["image", "context", "target", "buffer"],
    IMAGE_DESTROY: ["image"],
    POST: ["color_buffer"],
    FLUSH_SURFACE: ["surface"],
    READ_PIXELS: ["conn", "request", "x", "y", "width", "height", "format", "type"],
    CONNECTION_CLOSE: ["conn"],
    PROGRAM_LINK: ["conn", "program", "length"],
    BUFFER_READ: ["conn", "request", "buffer", "offset", "length"],
    QUERY_READ: ["conn", "request", "query"],
};

/** Record names by opcode */
export const GLES_RECORD_NAMES = Object.fromEntries(Object.entries(GLES).map(([name, op]) => [op, name]));

/**
 * A record read back
 * @typedef {{op: number, name: string, bytes: (Uint8Array|undefined), command: (Object|undefined), args: (Array|undefined)}}
 */
export let GLESRecord;

/**
 * A batch's records, in order: each its fields by name; a command's bytes
 * (and with `decode`, the command and its arguments, gles_wire.js's), an
 * update's pixels. Throws on a batch that is not one.
 * @param {!Uint8Array} bytes
 * @param {boolean=} decode
 * @return {!Array<!Object>}
 */
export function read_gles_batch(bytes, decode)
{
    if(bytes.length < 16 || bytes.length % 4) throw new Error(`GLES batch: ${bytes.length} bytes`);
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
    if(words[0] !== GLES_MAGIC) throw new Error("GLES batch: magic " + words[0].toString(16));
    if(words[2] !== words.length) throw new Error(`GLES batch: ${words[2]} dwords in the header, ${words.length} sent`);
    const records = [];
    let at = 4;
    for(let i = 0; i < words[3]; i++)
    {
        if(at + 2 > words.length) throw new Error("GLES batch: record " + i + " is beyond its end");
        const op = words[at], body = words[at + 1];
        const name = GLES_RECORD_NAMES[op];
        const fields = GLES_FIELDS[name];
        if(!fields || at + 2 + body > words.length || body < fields.length) throw new Error(`GLES batch: record ${i}: op ${op}, ${body} dwords`);
        const record = { op, name };
        fields.forEach((field, j) => { record[field] = words[at + 2 + j]; });
        const length = name === "COMMAND" || name === "COLOR_BUFFER_UPDATE" || name === "PROGRAM_LINK" ? record.length : 0;
        if(length)
        {
            const start = (at + 2 + fields.length) * 4;
            if(start + length > (at + 2 + body) * 4) throw new Error(`GLES batch: record ${i}: ${length} bytes in ${body} dwords`);
            record.bytes = bytes.subarray(start, start + length);
            if(name === "COMMAND" && decode)
            {
                const view = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.length);
                record.command = command_of_opcode(view.getUint32(0, true));
                if(!record.command) throw new Error(`GLES batch: record ${i}: opcode ${view.getUint32(0, true)}`);
                record.args = decode_arguments(record.command, record.bytes);
            }
        }
        records.push(record);
        at += 2 + body;
    }
    if(at !== words.length) throw new Error(`GLES batch: the records end at ${at} of ${words.length} dwords`);
    return records;
}
