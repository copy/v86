import { h } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";
import { CPU } from "./cpu.js";

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

    const buffer = buffers[obj["buffer_id"]];
    return new constructor(buffer);
}

/* @param {CPU} cpu */
export function save_state(cpu)
{
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

        // align
        total_buffer_size = total_buffer_size + 3 & ~3;
    }

    var info_object = JSON.stringify({
        "buffer_infos": buffer_infos,
        "state": state,
    });
    var info_block = new TextEncoder().encode(info_object);

    var buffer_block_start = STATE_INFO_BLOCK_START + info_block.length;
    buffer_block_start = buffer_block_start + 3 & ~3;
    var total_size = buffer_block_start + total_buffer_size;

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

        new Uint8Array(cpu.wasm_memory.buffer, cpu.zstd_get_src_ptr(ctx), state.length).set(state);

        let ptr = cpu.zstd_read(ctx, 16);
        const header_block = new Uint8Array(cpu.wasm_memory.buffer, ptr, 16);
        const info_block_len = read_state_header(header_block, false);
        cpu.zstd_read_free(ptr, 16);

        ptr = cpu.zstd_read(ctx, info_block_len);
        const info_block_buffer = new Uint8Array(cpu.wasm_memory.buffer, ptr, info_block_len);
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
                const ptr = cpu.zstd_read(ctx, front_padding);
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
                    buffer.set(new Uint8Array(cpu.wasm_memory.buffer, ptr, to_read), have);
                    cpu.zstd_read_free(ptr, to_read);

                    have += to_read;
                }
            }
            else
            {
                const ptr = cpu.zstd_read(ctx, front_padding + buffer_info.length);
                const offset = ptr + front_padding;
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
