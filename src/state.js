"use strict";

/** @const */
var STATE_VERSION = 6;

/** @const */
var STATE_MAGIC = 0x86768676|0;

/** @const */
var STATE_INDEX_MAGIC = 0;

/** @const */
var STATE_INDEX_VERSION = 1;

/** @const */
var STATE_INDEX_TOTAL_LEN = 2;

/** @const */
var STATE_INDEX_INFO_LEN = 3;

/** @const */
var STATE_INFO_BLOCK_START = 16;


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

    if(obj instanceof Array)
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

    if(obj instanceof Array)
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

    const info = buffers.infos[obj["buffer_id"]];

    // restore large buffers by just returning a view on the state blob
    // get_state is responsible for copying the data
    if(info.length >= 1024 * 1024 && constructor === Uint8Array)
    {
        return new Uint8Array(buffers.full, info.offset, info.length);
    }
    else
    {
        var buf = buffers.full.slice(info.offset, info.offset + info.length);
        return new constructor(buf);
    }
}

CPU.prototype.save_state = function()
{
    var saved_buffers = [];
    var state = save_object(this, saved_buffers);

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

    return result;
};

CPU.prototype.restore_state = function(state)
{
    var len = state.byteLength;

    if(len < STATE_INFO_BLOCK_START)
    {
        throw new StateLoadError("Invalid length: " + len);
    }

    var header_block = new Int32Array(state, 0, 4);

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

    if(header_block[STATE_INDEX_TOTAL_LEN] !== len)
    {
        throw new StateLoadError(
                "Length doesn't match header: " +
                "real=" + len + " header=" + header_block[STATE_INDEX_TOTAL_LEN]);
    }

    var info_block_len = header_block[STATE_INDEX_INFO_LEN];

    if(info_block_len < 0 || info_block_len + 12 >= state.length)
    {
        throw new StateLoadError("Invalid info block length: " + info_block_len);
    }

    function read_info_block(info_block_buffer)
    {
        const info_block = new TextDecoder().decode(info_block_buffer);
        return JSON.parse(info_block);
    }

    const info_block_buffer = new Uint8Array(state, STATE_INFO_BLOCK_START, info_block_len);
    var info_block_obj = read_info_block(info_block_buffer);

    var state_object = info_block_obj["state"];
    var buffer_infos = info_block_obj["buffer_infos"];
    var buffer_block_start = STATE_INFO_BLOCK_START + info_block_len;
    buffer_block_start = buffer_block_start + 3 & ~3;

    for(var i = 0; i < buffer_infos.length; i++)
    {
        buffer_infos[i].offset += buffer_block_start;
    }

    var buffers = {
        full: state,
        infos: buffer_infos,
    };

    state_object = restore_buffers(state_object, buffers);
    this.set_state(state_object);
};
