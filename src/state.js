import { h } from "./lib.js";
import { STATE_MAX_SINGLE_BUFFER } from "./const.js";
import { dbg_assert, dbg_log } from "./log.js";
import { CPU } from "./cpu.js";
import { check_no_disk_holds } from "./block_backend.js";

const STATE_VERSION = 6;
const STATE_MAGIC = 0x86768676|0;
const STATE_INDEX_MAGIC = 0;
const STATE_INDEX_VERSION = 1;
const STATE_INDEX_TOTAL_LEN = 2;
const STATE_INDEX_INFO_LEN = 3;
const STATE_INFO_BLOCK_START = 16;

const ZSTD_MAGIC = 0xFD2FB528;

/** @constructor */
function StateLoadError(msg)
{
    this.message = msg;
}
StateLoadError.prototype = new Error;

const CONSTRUCTOR_TABLE = {
    "Map": Map,
    "Uint8Array": Uint8Array,
    "Int8Array": Int8Array,
    "Uint16Array": Uint16Array,
    "Int16Array": Int16Array,
    "Uint32Array": Uint32Array,
    "Int32Array": Int32Array,
    "Float32Array": Float32Array,
    "Float64Array": Float64Array,
};

function save_object(obj, saved_buffers)
{
    if(typeof obj !== "object" || obj === null)
    {
        dbg_assert(typeof obj !== "function");
        return obj;
    }

    if(Array.isArray(obj))
    {
        return obj.map(x => save_object(x, saved_buffers));
    }

    if(obj instanceof Map)
    {
        return {
            "__state_type__": "Map",
            "args": Array.from(obj.entries()).map(([k, v]) => [
                save_object(k, saved_buffers),
                save_object(v, saved_buffers),
            ]),
        };
    }

    if(obj.constructor === Object)
    {
        console.log(obj);
        dbg_assert(obj.constructor !== Object, "Expected non-object");
    }

    if(obj.BYTES_PER_ELEMENT)
    {
        // Uint8Array, etc.
        var buffer = new Uint8Array(obj.buffer, obj.byteOffset, obj.length * obj.BYTES_PER_ELEMENT);

        const constructor = obj.constructor.name.replace("bound ", "");

        dbg_assert(CONSTRUCTOR_TABLE[constructor]);

        return {
            "__state_type__": constructor,
            "buffer_id": saved_buffers.push(buffer) - 1,
        };
    }

    if(DEBUG && !obj.get_state)
    {
        console.log("Object without get_state: ", obj);
    }

    var state = obj.get_state();
    var result = [];

    for(var i = 0; i < state.length; i++)
    {
        var value = state[i];

        dbg_assert(typeof value !== "function");

        result[i] = save_object(value, saved_buffers);
    }

    return result;
}

function restore_buffers(obj, buffers)
{
    if(typeof obj !== "object" || obj === null)
    {
        dbg_assert(typeof obj !== "function");
        return obj;
    }

    if(Array.isArray(obj))
    {
        for(let i = 0; i < obj.length; i++)
        {
            obj[i] = restore_buffers(obj[i], buffers);
        }

        return obj;
    }

    const type = obj["__state_type__"];
    dbg_assert(type !== undefined);

    const constructor = CONSTRUCTOR_TABLE[type];
    dbg_assert(constructor, "Unkown type: " + type);

    if(obj["args"] !== undefined) {
        return new constructor(restore_buffers(obj["args"], buffers));
    }

    const buffer = buffers[obj["buffer_id"]];
    return new constructor(buffer);
}

/* @param {CPU} cpu */
export function save_state(cpu)
{
    // (not while disk requests are held after an I/O error: src/block_backend.js)
    check_no_disk_holds(cpu);
    var saved_buffers = [];
    var state = save_object(cpu, saved_buffers);

    var buffer_infos = [];
    var total_buffer_size = 0;

    for(var i = 0; i < saved_buffers.length; i++)
    {
        var len = saved_buffers[i].byteLength;

        buffer_infos[i] = {
            offset: total_buffer_size,
            length: len,
        };

        total_buffer_size += len;

        // align (not with 32-bit operators: the sum may pass 2 GiB)
        total_buffer_size += (4 - total_buffer_size % 4) % 4;
    }
    if(total_buffer_size > STATE_MAX_SINGLE_BUFFER)
    {
        throw new RangeError("The state (" + Math.ceil(total_buffer_size / 1048576) + " MB) is larger than a single-buffer " +
            "snapshot can be (2 GiB): use save_state_stream");
    }

    var info_object = JSON.stringify({
        "buffer_infos": buffer_infos,
        "state": state,
    });
    var info_block = new TextEncoder().encode(info_object);

    var buffer_block_start = STATE_INFO_BLOCK_START + info_block.length;
    buffer_block_start = buffer_block_start + 3 & ~3;
    var total_size = buffer_block_start + total_buffer_size;
    if(total_size > STATE_MAX_SINGLE_BUFFER)
    {
        throw new RangeError("The state (" + Math.ceil(total_size / 1048576) + " MB) is larger than a single-buffer " +
            "snapshot can be (2 GiB): use save_state_stream");
    }

    //console.log("State: json_size=" + Math.ceil(buffer_block_start / 1024 / 1024) + "MB " +
    //               "buffer_size=" + Math.ceil(total_buffer_size / 1024 / 1024) + "MB");

    var result = new ArrayBuffer(total_size);

    var header_block = new Int32Array(
        result,
        0,
        STATE_INFO_BLOCK_START / 4
    );
    new Uint8Array(result, STATE_INFO_BLOCK_START, info_block.length).set(info_block);
    var buffer_block = new Uint8Array(
        result,
        buffer_block_start
    );

    header_block[STATE_INDEX_MAGIC] = STATE_MAGIC;
    header_block[STATE_INDEX_VERSION] = STATE_VERSION;
    header_block[STATE_INDEX_TOTAL_LEN] = total_size;
    header_block[STATE_INDEX_INFO_LEN] = info_block.length;

    for(var i = 0; i < saved_buffers.length; i++)
    {
        var buffer = saved_buffers[i];
        dbg_assert(buffer.constructor === Uint8Array);
        buffer_block.set(buffer, buffer_infos[i].offset);
    }

    dbg_log("State: json size " + (info_block.byteLength >> 10) + "k");
    dbg_log("State: Total buffers size " + (buffer_block.byteLength >> 10) + "k");

    return result;
}

/* @param {CPU} cpu */
export function restore_state(cpu, state)
{
    state = new Uint8Array(state);
    if(state.length < 4) throw new StateLoadError("Invalid snapshot length: " + state.length);

    function read_state_header(state, check_length)
    {
        const len = state.length;

        if(len < STATE_INFO_BLOCK_START)
        {
            throw new StateLoadError("Invalid length: " + len);
        }

        const header_block = new Int32Array(state.buffer, state.byteOffset, 4);

        if(header_block[STATE_INDEX_MAGIC] !== STATE_MAGIC)
        {
            throw new StateLoadError("Invalid header: " + h(header_block[STATE_INDEX_MAGIC] >>> 0));
        }

        if(header_block[STATE_INDEX_VERSION] !== STATE_VERSION)
        {
            throw new StateLoadError(
                    "Version mismatch: dump=" + header_block[STATE_INDEX_VERSION] +
                    " we=" + STATE_VERSION);
        }

        if(check_length && header_block[STATE_INDEX_TOTAL_LEN] !== len)
        {
            throw new StateLoadError(
                    "Length doesn't match header: " +
                    "real=" + len + " header=" + header_block[STATE_INDEX_TOTAL_LEN]);
        }

        return header_block[STATE_INDEX_INFO_LEN];
    }

    function read_info_block(info_block_buffer)
    {
        const info_block = new TextDecoder().decode(info_block_buffer);
        return JSON.parse(info_block);
    }

    if(new Uint32Array(state.buffer, 0, 1)[0] === ZSTD_MAGIC)
    {
        const ctx = cpu.zstd_create_ctx(state.length);

        new Uint8Array(cpu.wasm_memory.buffer, cpu.zstd_get_src_ptr(ctx) >>> 0, state.length).set(state);

        let ptr = cpu.zstd_read(ctx, 16);
        const header_block = new Uint8Array(cpu.wasm_memory.buffer, ptr >>> 0, 16);
        const info_block_len = read_state_header(header_block, false);
        cpu.zstd_read_free(ptr, 16);

        ptr = cpu.zstd_read(ctx, info_block_len);
        const info_block_buffer = new Uint8Array(cpu.wasm_memory.buffer, ptr >>> 0, info_block_len);
        const info_block_obj = read_info_block(info_block_buffer);
        cpu.zstd_read_free(ptr, info_block_len);

        let state_object = info_block_obj["state"];
        const buffer_infos = info_block_obj["buffer_infos"];
        const buffers = [];

        let position = STATE_INFO_BLOCK_START + info_block_len;

        for(const buffer_info of buffer_infos)
        {
            const front_padding = (position + 3 & ~3) - position;
            const CHUNK_SIZE = 1 * 1024 * 1024;

            if(buffer_info.length > CHUNK_SIZE)
            {
                const ptr = cpu.zstd_read(ctx, front_padding) >>> 0;
                cpu.zstd_read_free(ptr, front_padding);

                const buffer = new Uint8Array(buffer_info.length);
                buffers.push(buffer.buffer);

                let have = 0;
                while(have < buffer_info.length)
                {
                    const remaining = buffer_info.length - have;
                    dbg_assert(remaining >= 0);
                    const to_read = Math.min(remaining, CHUNK_SIZE);

                    const ptr = cpu.zstd_read(ctx, to_read);
                    buffer.set(new Uint8Array(cpu.wasm_memory.buffer, ptr >>> 0, to_read), have);
                    cpu.zstd_read_free(ptr, to_read);

                    have += to_read;
                }
            }
            else
            {
                const ptr = cpu.zstd_read(ctx, front_padding + buffer_info.length);
                const offset = (ptr >>> 0) + front_padding;
                buffers.push(cpu.wasm_memory.buffer.slice(offset, offset + buffer_info.length));
                cpu.zstd_read_free(ptr, front_padding + buffer_info.length);
            }

            position += front_padding + buffer_info.length;
        }

        state_object = restore_buffers(state_object, buffers);
        cpu.set_state(state_object);

        cpu.zstd_free_ctx(ctx);
    }
    else
    {
        const info_block_len = read_state_header(state, true);

        if(info_block_len < 0 || info_block_len + 12 >= state.length)
        {
            throw new StateLoadError("Invalid info block length: " + info_block_len);
        }

        const info_block_buffer = state.subarray(STATE_INFO_BLOCK_START, STATE_INFO_BLOCK_START + info_block_len);
        const info_block_obj = read_info_block(info_block_buffer);
        let state_object = info_block_obj["state"];
        const buffer_infos = info_block_obj["buffer_infos"];
        let buffer_block_start = STATE_INFO_BLOCK_START + info_block_len;
        buffer_block_start = buffer_block_start + 3 & ~3;

        const buffers = buffer_infos.map(buffer_info => {
            const offset = buffer_block_start + buffer_info.offset;
            return state.buffer.slice(offset, offset + buffer_info.length);
        });

        state_object = restore_buffers(state_object, buffers);
        cpu.set_state(state_object);
    }
}

// V7 is a stream of a small manifest and independently checked records. RAM is
// packed directly from backing pages into one reusable-size record, never into
// the V6 packed_memory allocation. Guest physical addresses are only metadata.
export const STATE_STREAM_CHUNK_SIZE = 1024 * 1024;
const STREAM_VERSION = 7;
const STREAM_HEADER_SIZE = 32;
const STREAM_RECORD_SIZE = 20;
const STREAM_RAM_CHUNK = STATE_STREAM_CHUNK_SIZE - 4096;
const STREAM_INFO_LIMIT = 16 * 1024 * 1024;

function stream_error(message)
{
    throw new StateLoadError("Invalid V7 snapshot: " + message);
}

// CRC-32 (IEEE, as zlib's), slicing-by-16: 16 tables, 16 bytes a step read as
// four little-endian words, five times as fast as a byte a step (which made
// about half the time of saving a snapshot of gigabytes)
const STREAM_CRC_TABLE = new Int32Array(16 * 256);
for(let i = 0; i < 256; i++)
{
    let value = i;
    for(let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xEDB88320 : 0);
    STREAM_CRC_TABLE[i] = value;
}
for(let i = 256; i < 16 * 256; i++)
{
    const previous = STREAM_CRC_TABLE[i - 256];
    STREAM_CRC_TABLE[i] = previous >>> 8 ^ STREAM_CRC_TABLE[previous & 255];
}
function stream_crc(bytes)
{
    const table = STREAM_CRC_TABLE, length = bytes.length;
    let crc = -1, i = 0;
    // byte by byte up to a word boundary, then 16 bytes a step, then the rest
    for(const head = Math.min(length, -bytes.byteOffset & 3); i < head; i++) crc = crc >>> 8 ^ table[(crc ^ bytes[i]) & 255];
    const count = (length - i) >> 4 << 2;
    if(count)
    {
        const words = new Int32Array(bytes.buffer, bytes.byteOffset + i, count);
        for(let w = 0; w < count; w += 4)
        {
            const a = crc ^ words[w], b = words[w + 1], c = words[w + 2], d = words[w + 3];
            crc = table[3840 + (a & 255)] ^ table[3584 + (a >>> 8 & 255)] ^ table[3328 + (a >>> 16 & 255)] ^ table[3072 + (a >>> 24)] ^
                table[2816 + (b & 255)] ^ table[2560 + (b >>> 8 & 255)] ^ table[2304 + (b >>> 16 & 255)] ^ table[2048 + (b >>> 24)] ^
                table[1792 + (c & 255)] ^ table[1536 + (c >>> 8 & 255)] ^ table[1280 + (c >>> 16 & 255)] ^ table[1024 + (c >>> 24)] ^
                table[768 + (d & 255)] ^ table[512 + (d >>> 8 & 255)] ^ table[256 + (d >>> 16 & 255)] ^ table[d >>> 24];
        }
        i += count * 4;
    }
    for(; i < length; i++) crc = crc >>> 8 ^ table[(crc ^ bytes[i]) & 255];
    return (crc ^ -1) >>> 0;
}

function stream_record(kind, id, offset, data)
{
    const bytes = new Uint8Array(STREAM_RECORD_SIZE + data.length);
    const words = new DataView(bytes.buffer);
    words.setUint32(0, kind, true);
    words.setUint32(4, id, true);
    words.setUint32(8, offset, true);
    words.setUint32(12, data.length, true);
    bytes.set(data, 16);
    words.setUint32(16 + data.length, stream_crc(bytes.subarray(0, 16 + data.length)), true);
    return bytes;
}

// Pulling one chunk at a time also gives the Worker transport real backpressure.
export function create_state_stream(cpu)
{
    check_no_disk_holds(cpu);
    const memory_size = cpu.memory_size[0] >>> 0;
    if(memory_size > cpu.mem8.length || memory_size % 4096) stream_error("RAM size");
    const bitmap = new Uint8Array(Math.ceil(memory_size / 4096 / 8));
    let packed_size = 0;
    for(let page = 0; page < memory_size / 4096; page++)
    {
        if(!cpu.is_memory_zeroed(page * 4096, 4096))
        {
            bitmap[page >> 3] |= 1 << (page & 7);
            packed_size += 4096;
        }
    }
    // extended RAM: the pages that are not zero, after the RAM records
    const extended = cpu.extended_store;
    let extended_bitmap = null, extended_packed = 0;
    if(extended)
    {
        cpu.flush_extended_memory();
        extended_bitmap = new Uint8Array(Math.ceil(extended.pages / 8));
        for(let page = 0; page < extended.pages; page++)
        {
            if(!extended.is_zero(page))
            {
                extended_bitmap[page >> 3] |= 1 << (page & 7);
                extended_packed++;
            }
        }
    }
    const state = cpu.get_state(true);
    state[77] = null;
    state[78] = bitmap;
    state[99] = extended_bitmap;
    const buffers = [];
    const manifest = new TextEncoder().encode(JSON.stringify({
        "state": save_object(state, buffers),
        "buffers": buffers.map(buffer => buffer.length),
        "extended_pages": extended_packed,
    }));
    if(manifest.length > STREAM_INFO_LIMIT) stream_error("manifest too large");
    const header = new Uint8Array(STREAM_HEADER_SIZE);
    const words = new DataView(header.buffer);
    [STATE_MAGIC, STREAM_VERSION, STATE_STREAM_CHUNK_SIZE, manifest.length, buffers.length,
        memory_size, packed_size, stream_crc(manifest)].forEach((value, index) => words.setUint32(index * 4, value, true));
    let phase = 0, position = 0, buffer_id = 0, ram_page = 0, extended_page = 0;
    const extended_size = extended_packed * 4096;
    return {
        "next": () => {
            if(phase === 0) { phase = 1; return header; }
            if(phase === 1)
            {
                if(position < manifest.length)
                {
                    const part = manifest.slice(position, position + STATE_STREAM_CHUNK_SIZE);
                    position += part.length;
                    return part;
                }
                phase = 2;
                position = 0;
            }
            if(phase === 2)
            {
                while(buffer_id < buffers.length)
                {
                    const buffer = buffers[buffer_id];
                    if(position < buffer.length)
                    {
                        const part = stream_record(1, buffer_id, position,
                            buffer.subarray(position, position + STATE_STREAM_CHUNK_SIZE - STREAM_RECORD_SIZE));
                        position += part.length - STREAM_RECORD_SIZE;
                        return part;
                    }
                    buffer_id++;
                    position = 0;
                }
                phase = 3;
                position = 0;
            }
            if(phase === 3)
            {
                if(position < packed_size)
                {
                    const length = Math.min(STREAM_RAM_CHUNK, packed_size - position);
                    const data = new Uint8Array(length);
                    for(let offset = 0; offset < length; offset += 4096)
                    {
                        while(!(bitmap[ram_page >> 3] & 1 << (ram_page & 7))) ram_page++;
                        data.set(cpu.mem8.subarray(ram_page * 4096, (ram_page + 1) * 4096), offset);
                        ram_page++;
                    }
                    const result = stream_record(2, 0, position, data);
                    position += length;
                    return result;
                }
                phase = 4;
                position = 0;
            }
            // extended RAM: records of kind 3; id and offset are the high and
            // low 32 bits of the position in its packed pages
            if(position === extended_size) return null;
            const length = Math.min(STREAM_RAM_CHUNK, extended_size - position);
            const data = new Uint8Array(length);
            for(let offset = 0; offset < length; offset += 4096)
            {
                while(!(extended_bitmap[extended_page >> 3] & 1 << (extended_page & 7))) extended_page++;
                data.set(extended.page(extended_page), offset);
                extended_page++;
            }
            const result = stream_record(3, Math.floor(position / 0x100000000), position >>> 0, data);
            position += length;
            return result;
        },
    };
}

export async function save_state_stream(cpu, write)
{
    if(typeof write !== "function") throw new TypeError("Snapshot writer must be a function");
    const stream = create_state_stream(cpu);
    for(let chunk; (chunk = stream["next"]()) !== null;) await write(chunk);
}

export function state_stream_source(source)
{
    if(typeof Blob !== "undefined" && source instanceof Blob)
    {
        return { "size": source.size,
            "read": async (offset, length) => new Uint8Array(await source.slice(offset, offset + length).arrayBuffer()) };
    }
    if(!source || !Number.isSafeInteger(source["size"]) || source["size"] < STREAM_HEADER_SIZE ||
        typeof source["read"] !== "function") throw new TypeError("Snapshot source requires size and read(offset, length)");
    return source;
}

async function stream_read(source, offset, length)
{
    if(length > STATE_STREAM_CHUNK_SIZE || offset + length > source["size"]) stream_error("truncated record");
    const bytes = await source["read"](offset, length);
    if(!(bytes instanceof Uint8Array) || bytes.length !== length) stream_error("short read");
    return bytes;
}

function validate_stream_tree(obj, buffers, depth = 0)
{
    if(depth > 256) stream_error("state nesting");
    if(obj === null || typeof obj !== "object") return;
    if(Array.isArray(obj))
    {
        for(const child of obj) validate_stream_tree(child, buffers, depth + 1);
        return;
    }
    const type = obj["__state_type__"];
    if(type === "Map" && Array.isArray(obj["args"]))
    {
        validate_stream_tree(obj["args"], buffers, depth + 1);
        return;
    }
    const constructor = CONSTRUCTOR_TABLE[type], id = obj["buffer_id"];
    if(!Object.prototype.hasOwnProperty.call(CONSTRUCTOR_TABLE, type) || type === "Map" ||
        !Number.isInteger(id) || id < 0 || id >= buffers.length ||
        buffers[id] % constructor.BYTES_PER_ELEMENT) stream_error("typed buffer reference");
}

// The source must remain immutable for both passes (Blob/File are convenient).
// Pass 1 checks every byte before live RAM changes. Pass 2 writes directly into
// existing backing RAM. A late I/O failure leaves the machine stopped; it cannot
// promise rollback without retaining a second RAM image.
export async function restore_state_stream(cpu, input)
{
    const source = state_stream_source(input);
    const header = await stream_read(source, 0, STREAM_HEADER_SIZE);
    const words = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if(words.getUint32(0, true) !== (STATE_MAGIC >>> 0) || words.getUint32(4, true) !== STREAM_VERSION ||
        words.getUint32(8, true) !== STATE_STREAM_CHUNK_SIZE) stream_error("header/version");
    const info_size = words.getUint32(12, true), buffer_count = words.getUint32(16, true);
    const memory_size = words.getUint32(20, true), packed_size = words.getUint32(24, true);
    if(!info_size || info_size > STREAM_INFO_LIMIT || memory_size > cpu.mem8.length || memory_size % 4096 ||
        packed_size > memory_size || packed_size % 4096) stream_error("manifest/RAM size");
    const manifest = new Uint8Array(info_size);
    for(let offset = 0; offset < info_size; offset += STATE_STREAM_CHUNK_SIZE)
        manifest.set(await stream_read(source, STREAM_HEADER_SIZE + offset, Math.min(STATE_STREAM_CHUNK_SIZE, info_size - offset)), offset);
    if(stream_crc(manifest) !== words.getUint32(28, true)) stream_error("manifest checksum");
    let info;
    try { info = JSON.parse(new TextDecoder("utf-8", { "fatal": true }).decode(manifest)); }
    catch(_) { stream_error("manifest JSON"); }
    const lengths = info["buffers"];
    if(!Array.isArray(lengths) || lengths.length !== buffer_count || buffer_count > 65536 ||
        lengths.some(length => !Number.isSafeInteger(length) || length < 0 || length > 0xFFFFFFFF)) stream_error("buffer lengths");
    let total = STREAM_HEADER_SIZE + info_size;
    for(const length of lengths) total += length + Math.ceil(length / (STATE_STREAM_CHUNK_SIZE - STREAM_RECORD_SIZE)) * STREAM_RECORD_SIZE;
    total += packed_size + Math.ceil(packed_size / STREAM_RAM_CHUNK) * STREAM_RECORD_SIZE;
    const extended_packed = info["extended_pages"] === undefined ? 0 : info["extended_pages"];
    if(!Number.isSafeInteger(extended_packed) || extended_packed < 0 || extended_packed > cpu.extended_pages) stream_error("extended RAM size");
    const extended_size = extended_packed * 4096;
    total += extended_size + Math.ceil(extended_size / STREAM_RAM_CHUNK) * STREAM_RECORD_SIZE;
    if(total !== source["size"]) stream_error("total length");
    validate_stream_tree(info["state"], lengths);
    const buffers = [];
    let position = STREAM_HEADER_SIZE + info_size;
    const read_record = async (kind, id, offset, length) => {
        const bytes = await stream_read(source, position, STREAM_RECORD_SIZE + length);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if(view.getUint32(0, true) !== kind || view.getUint32(4, true) !== id ||
            view.getUint32(8, true) !== offset || view.getUint32(12, true) !== length ||
            view.getUint32(16 + length, true) !== stream_crc(bytes.subarray(0, 16 + length))) stream_error("record/checksum");
        position += bytes.length;
        return bytes;
    };
    for(let id = 0; id < lengths.length; id++)
    {
        const buffer = new Uint8Array(lengths[id]);
        for(let offset = 0; offset < buffer.length;)
        {
            const length = Math.min(STATE_STREAM_CHUNK_SIZE - STREAM_RECORD_SIZE, buffer.length - offset);
            const bytes = await read_record(1, id, offset, length);
            buffer.set(bytes.subarray(16, 16 + length), offset);
            offset += length;
        }
        buffers.push(buffer.buffer);
    }
    const state = restore_buffers(info["state"], buffers);
    if(!Array.isArray(state) || state[0] !== memory_size || state[77] !== null ||
        !(state[78] instanceof Uint8Array) || state[78].length !== Math.ceil(memory_size / 4096 / 8)) stream_error("RAM bitmap");
    const bitmap = state[78];
    let count = 0;
    for(let page = 0; page < bitmap.length * 8; page++) if(bitmap[page >> 3] & 1 << (page & 7))
    {
        if(page >= memory_size / 4096) stream_error("bitmap beyond RAM");
        count++;
    }
    if(count * 4096 !== packed_size) stream_error("bitmap count");
    const extended_bitmap = state[99] || null;
    if(extended_packed || extended_bitmap)
    {
        if(!(extended_bitmap instanceof Uint8Array) || extended_bitmap.length !== Math.ceil(cpu.extended_pages / 8)) stream_error("extended RAM bitmap");
        let pages = 0;
        for(let page = 0; page < extended_bitmap.length * 8; page++) if(extended_bitmap[page >> 3] & 1 << (page & 7))
        {
            if(page >= cpu.extended_pages) stream_error("extended bitmap beyond RAM");
            pages++;
        }
        if(pages !== extended_packed) stream_error("extended bitmap count");
    }
    cpu.validate_state(state);
    const ram_start = position, checksums = [];
    for(let offset = 0; offset < packed_size; offset += STREAM_RAM_CHUNK)
    {
        const length = Math.min(STREAM_RAM_CHUNK, packed_size - offset);
        const bytes = await read_record(2, 0, offset, length);
        checksums.push(new DataView(bytes.buffer, bytes.byteOffset).getUint32(16 + length, true));
    }
    for(let offset = 0; offset < extended_size; offset += STREAM_RAM_CHUNK)
    {
        const length = Math.min(STREAM_RAM_CHUNK, extended_size - offset);
        const bytes = await read_record(3, Math.floor(offset / 0x100000000), offset >>> 0, length);
        checksums.push(new DataView(bytes.buffer, bytes.byteOffset).getUint32(16 + length, true));
    }
    // No architectural or RAM mutation has occurred before this point.
    cpu.zero_memory(0, memory_size);
    position = ram_start;
    let page = 0, record = 0;
    for(let offset = 0; offset < packed_size; offset += STREAM_RAM_CHUNK)
    {
        const length = Math.min(STREAM_RAM_CHUNK, packed_size - offset);
        const bytes = await read_record(2, 0, offset, length);
        if(new DataView(bytes.buffer, bytes.byteOffset).getUint32(16 + length, true) !== checksums[record++]) stream_error("source changed between passes");
        for(let part = 0; part < length; part += 4096)
        {
            while(!(bitmap[page >> 3] & 1 << (page & 7))) page++;
            cpu.mem8.set(bytes.subarray(16 + part, 16 + part + 4096), page * 4096);
            page++;
        }
    }
    cpu.clear_extended_memory();
    let extended_page = 0;
    for(let offset = 0; offset < extended_size; offset += STREAM_RAM_CHUNK)
    {
        const length = Math.min(STREAM_RAM_CHUNK, extended_size - offset);
        const bytes = await read_record(3, Math.floor(offset / 0x100000000), offset >>> 0, length);
        if(new DataView(bytes.buffer, bytes.byteOffset).getUint32(16 + length, true) !== checksums[record++]) stream_error("source changed between passes");
        for(let part = 0; part < length; part += 4096)
        {
            while(!(extended_bitmap[extended_page >> 3] & 1 << (extended_page & 7))) extended_page++;
            cpu.extended_store.write(extended_page, bytes.subarray(16 + part, 16 + part + 4096));
            extended_page++;
        }
    }
    cpu.set_state(state, true);
}
