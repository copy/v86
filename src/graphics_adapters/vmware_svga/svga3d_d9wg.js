// D9WG batches, the renderer's input. The SVGA3D layer (svga3d.js) turns the
// guest's legacy 3D commands into the protocol the D3D9 executor
// (src/browser/glbridge/d3d9-webgpu/d3d9_executor.js) already runs for the
// guest D3D9 proxy, at the protocol's current version. A batch
// is self-contained (inline data travels in it), so it can be recorded and
// replayed without the guest.

import { dbg_assert } from "../../log.js";
import { D9WG_MAGIC, D9WG_VERSION_MAJOR, D9WG_VERSION_MINOR, OP, KIND, PAYLOAD_BYTES, FIELD_LAYOUT, COMMAND_STRUCT } from "./d9wg_constants.js";

// The opcodes, the resource kinds and every payload's size come from
// src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js (d9wg_constants.js is
// generated from it); the fields of each command follow its struct there.
export { D9WG_MAGIC, D9WG_BATCH_FLAG_PRESENT, OP, KIND } from "./d9wg_constants.js";

const BATCH_HEADER_BYTES = FIELD_LAYOUT["BatchHeader"].bytes;
const COMMAND_HEADER_BYTES = FIELD_LAYOUT["CommandHeader"].bytes;
const COMMAND_SIZE_OFFSET = FIELD_LAYOUT["CommandHeader"].fields.find(field => field[0] === "size")[1];
/** @param {string} name @return {!Object<string, number>} */
const offsets = name => Object.fromEntries(FIELD_LAYOUT[name].fields.map(field => [field[0], Number(field[1])]));
const BATCH_FIELDS = offsets("BatchHeader"), COMMAND_FIELDS = offsets("CommandHeader");

// Every batch carries this session: one guest device, one resource namespace
const SESSION_LOW = 0x41475653;     // "SVGA"
const SESSION_HIGH = 0;

// (the response region's layout: ../renderer_protocol.js)

/**
 * Builds one batch at a time
 * @constructor
 * @param {number=} session_low
 * @param {number=} session_high
 */
export function D9WGWriter(session_low = SESSION_LOW, session_high = SESSION_HIGH)
{
    this.session_low = session_low >>> 0;
    this.session_high = session_high >>> 0;
    this.bytes = new Uint8Array(1 << 16);
    this.view = new DataView(this.bytes.buffer);
    this.length = BATCH_HEADER_BYTES;
    this.count = 0;
    this.sequence = 0;
    // the command being written: where its header is, and its opcode
    this.command_at = -1;
    this.opcode = 0;
    /** @type {?function()} called before each command: the other stream is sent first */
    this.before = null;
}

/** @return {boolean} */
D9WGWriter.prototype.empty = function()
{
    return this.count === 0;
};

/** @return {number} bytes so far */
D9WGWriter.prototype.size = function()
{
    return this.length;
};

D9WGWriter.prototype.reserve = function(bytes)
{
    if(this.length + bytes <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while(capacity < this.length + bytes) capacity *= 2;
    const bigger = new Uint8Array(capacity);
    bigger.set(this.bytes.subarray(0, this.length));
    this.bytes = bigger;
    this.view = new DataView(bigger.buffer);
};

/**
 * Start a command header; command() supplies the generated payload.
 * @param {number} opcode
 */
D9WGWriter.prototype.begin = function(opcode)
{
    if(this.before) this.before();
    this.end();
    this.command_at = this.length;
    this.opcode = opcode;
    this.struct("CommandHeader", { "opcode": opcode, "sequence": ++this.sequence });
    this.count++;
    return this;
};

/** A named payload; generated offsets are the only wire layout knowledge.
 * @param {number} opcode
 * @param {!Object<string, *>} values
 * @return {!D9WGWriter}
 */
D9WGWriter.prototype.command = function(opcode, values)
{
    const name = COMMAND_STRUCT[opcode];
    if(!name) throw new Error("Unknown D9WG opcode " + opcode);
    this.begin(opcode);
    this.struct(name, values);
    return this;
};

/** Append an inline struct (rectangles and vertex declarations too).
 * @param {string} name
 * @param {!Object<string, *>} values
 * @return {!D9WGWriter}
 */
D9WGWriter.prototype.struct = function(name, values)
{
    const layout = FIELD_LAYOUT[name], at = this.length;
    if(!layout) throw new Error("Unknown D9WG struct " + name);
    this.reserve(layout.bytes);
    this.bytes.fill(0, at, at + layout.bytes);
    write_struct(this.view, at, name, values);
    this.length += layout.bytes;
    return this;
};

/** @param {!DataView} view @param {number} at @param {string} name @param {!Object<string, *>} values */
function write_struct(view, at, name, values)
{
    const layout = FIELD_LAYOUT[name];
    for(const key of Object.keys(values))
        if(!layout.fields.some(field => field[0] === key)) throw new Error("Unknown D9WG field " + name + "." + key);
    for(const [field, offset, type, count] of layout.fields)
    {
        const value = values[field];
        if(value === undefined) continue;
        const size = type === "uint8_t" ? 1 : type === "uint16_t" ? 2 : 4;
        if(count > 1 && value.length !== count) throw new Error("D9WG array size: " + name + "." + field);
        for(let i = 0; i < count; i++)
        {
            const position = at + offset + i * size;
            const scalar = /** @type {number} */ (count === 1 ? value : value[i]);
            switch(type)
            {
                case "uint8_t": view.setUint8(position, scalar); break;
                case "uint16_t": view.setUint16(position, scalar, true); break;
                case "uint32_t": view.setUint32(position, scalar >>> 0, true); break;
                case "int32_t": view.setInt32(position, scalar | 0, true); break;
                case "float": view.setFloat32(position, scalar, true); break;
                default: throw new Error("Non-scalar D9WG field " + name + "." + field);
            }
        }
    }
}

/** Standalone inline data, using the same generated layout as commands.
 * @param {string} name @param {!Object<string, *>} values @return {!Uint8Array}
 */
export function d9wg_encode(name, values)
{
    const bytes = new Uint8Array(FIELD_LAYOUT[name].bytes);
    write_struct(new DataView(bytes.buffer), 0, name, values);
    return bytes;
}

/** Patch a named uint32 field after appending its blob.
 * @param {string} name
 * @param {number} value
 */
D9WGWriter.prototype.patch_field = function(name, value)
{
    const layout = FIELD_LAYOUT[COMMAND_STRUCT[this.opcode]];
    const field = layout.fields.find(field => field[0] === name);
    if(this.command_at < 0 || !field || field[2] !== "uint32_t" || field[3] !== 1)
        throw new Error("Invalid D9WG patch field " + name);
    this.view.setUint32(this.command_at + COMMAND_HEADER_BYTES + field[1], value >>> 0, true);
};

/** Finish the command being written: its size, padded to 8 bytes */
D9WGWriter.prototype.end = function()
{
    if(this.command_at < 0) return;
    dbg_assert(this.length - this.command_at - COMMAND_HEADER_BYTES >= PAYLOAD_BYTES[this.opcode],
        "D9WG opcode 0x" + this.opcode.toString(16) + ": the payload is shorter than its struct");
    const padded = this.length + 7 & ~7;
    this.reserve(padded - this.length);
    this.bytes.fill(0, this.length, padded);
    this.length = padded;
    this.view.setUint32(this.command_at + COMMAND_SIZE_OFFSET, this.length - this.command_at, true);
    this.command_at = -1;
};

/**
 * Raw bytes inside the current command
 * @param {!Uint8Array} bytes
 * @return {number} their offset from the start of the batch (data_offset)
 */
D9WGWriter.prototype.data = function(bytes)
{
    const at = this.length + 3 & ~3;
    this.reserve(at - this.length + bytes.length);
    this.bytes.fill(0, this.length, at);
    this.bytes.set(bytes, at);
    this.length = at + bytes.length;
    return at;
};

/**
 * Close the batch
 * @param {number} frame_id
 * @param {number} flags D9WG_BATCH_FLAG_*
 * @return {!Uint8Array} the batch, owned by the caller
 */
D9WGWriter.prototype.finish = function(frame_id, flags)
{
    this.end();
    write_struct(this.view, 0, "BatchHeader", {
        "magic": D9WG_MAGIC, "version_major": D9WG_VERSION_MAJOR, "version_minor": D9WG_VERSION_MINOR,
        "frame_id": frame_id, "flags": flags, "command_count": this.count,
        "command_bytes": this.length - BATCH_HEADER_BYTES, "session_id_low": this.session_low, "session_id_high": this.session_high,
    });
    const batch = this.bytes.slice(0, this.length);
    this.length = BATCH_HEADER_BYTES;
    this.count = 0;
    return batch;
};

/**
 * The commands of a batch, for tests and traces
 * @param {!Uint8Array} batch
 * @return {!Array<{opcode: number, view: !DataView, at: number, size: number}>}
 *     at: the payload's offset in the batch
 */
export function d9wg_commands(batch)
{
    if(batch.byteLength < BATCH_HEADER_BYTES) throw new Error("short D9WG header");
    const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
    if(view.getUint32(BATCH_FIELDS["magic"], true) !== D9WG_MAGIC) throw new Error("not a D9WG batch");
    const end = BATCH_HEADER_BYTES + view.getUint32(BATCH_FIELDS["command_bytes"], true);
    if(end !== batch.byteLength) throw new Error("D9WG byte count mismatch");
    const commands = [];
    for(let at = BATCH_HEADER_BYTES; at < end;)
    {
        if(at + COMMAND_HEADER_BYTES > end) throw new Error("short D9WG command header");
        const size = view.getUint32(at + COMMAND_FIELDS["size"], true);
        if(size < COMMAND_HEADER_BYTES || size & 7 || at + size > end) throw new Error("invalid D9WG command size");
        commands.push({ opcode: view.getUint16(at + COMMAND_FIELDS["opcode"], true), view, at: at + COMMAND_HEADER_BYTES, size: size - COMMAND_HEADER_BYTES });
        at += size;
    }
    if(commands.length !== view.getUint32(BATCH_FIELDS["command_count"], true)) throw new Error("D9WG command count mismatch");
    return commands;
}
