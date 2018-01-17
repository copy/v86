"use strict";

/** @const */
var STATE_VERSION = 5;

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


function save_object(obj, saved_buffers)
{
    if(typeof obj !== "object" || obj === null || obj instanceof Array)
    {
        return obj;
    }

    dbg_assert(obj.constructor !== Object);

    if(obj.BYTES_PER_ELEMENT)
    {
        // Uint8Array, etc.
        var buffer = new Uint8Array(obj.buffer, obj.byteOffset, obj.length * obj.BYTES_PER_ELEMENT);

        return {
            "__state_type__": obj.constructor.name,
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

function restore_object(base, obj, buffers)
{
    // recursively restore obj into base

    if(typeof obj !== "object" || obj === null)
    {
        return obj;
    }

    if(base instanceof Array)
    {
        return obj;
    }

    var type = obj["__state_type__"];

    if(type === undefined)
    {
        if(DEBUG && base === undefined)
        {
            console.log("Cannot restore (base doesn't exist)", obj);
            dbg_assert(false);
        }

        if(DEBUG && !base.get_state)
        {
            console.log("No get_state:", base);
        }

        var current = base.get_state();

        dbg_assert(current.length === obj.length, "Cannot restore: Different number of properties");

        for(var i = 0; i < obj.length; i++)
        {
            obj[i] = restore_object(current[i], obj[i], buffers);
        }

        base.set_state(obj);

        return base;
    }
    else
    {
        var table = {
            "Uint8Array": Uint8Array,
            "Int8Array": Int8Array,
            "Uint16Array": Uint16Array,
            "Int16Array": Int16Array,
            "Uint32Array": Uint32Array,
            "Int32Array": Int32Array,
            "Float32Array": Float32Array,
            "Float64Array": Float64Array,
        };

        var constructor = table[type];
        dbg_assert(constructor, "Unkown type: " + type);

        var info = buffers.infos[obj["buffer_id"]];

        dbg_assert(base);
        dbg_assert(base.constructor === constructor);

        // restore large buffers by just returning a view on the state blob
        if(info.length >= 1024 * 1024 && constructor === Uint8Array)
        {
            return new Uint8Array(buffers.full, info.offset, info.length);
        }
        // XXX: Disabled, unpredictable since it updates in-place, breaks pci
        //      and possibly also breaks restore -> save -> restore again
        // avoid a new allocation if possible
        //else if(base &&
        //        base.constructor === constructor &&
        //        base.byteOffset === 0 &&
        //        base.byteLength === info.length)
        //{
        //    new Uint8Array(base.buffer).set(
        //        new Uint8Array(buffers.full, info.offset, info.length),
        //        base.byteOffset
        //    );
        //    return base;
        //}
        else
        {
            var buf = buffers.full.slice(info.offset, info.offset + info.length);
            return new constructor(buf);
        }
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

    var buffer_block_start = STATE_INFO_BLOCK_START + 2 * info_object.length;
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
    var info_block = new Uint16Array(
        result,
        STATE_INFO_BLOCK_START,
        info_object.length
    );
    var buffer_block = new Uint8Array(
        result,
        buffer_block_start
    );

    header_block[STATE_INDEX_MAGIC] = STATE_MAGIC;
    header_block[STATE_INDEX_VERSION] = STATE_VERSION;
    header_block[STATE_INDEX_TOTAL_LEN] = total_size;
    header_block[STATE_INDEX_INFO_LEN] = info_object.length * 2;

    for(var i = 0; i < info_object.length; i++)
    {
        info_block[i] = info_object.charCodeAt(i);
    }

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

    if(info_block_len < 0 ||
       info_block_len + 12 >= len ||
       info_block_len % 2)
    {
        throw new StateLoadError("Invalid info block length: " + info_block_len);
    }

    var info_block_str_len = info_block_len / 2;
    var info_block_buffer = new Uint16Array(state, STATE_INFO_BLOCK_START, info_block_str_len);
    var info_block = "";

    for(var i = 0; i < info_block_str_len - 8; )
    {
        info_block += String.fromCharCode(
            info_block_buffer[i++], info_block_buffer[i++],
            info_block_buffer[i++], info_block_buffer[i++],
            info_block_buffer[i++], info_block_buffer[i++],
            info_block_buffer[i++], info_block_buffer[i++]
        );
    }

    for(; i < info_block_str_len; )
    {
        info_block += String.fromCharCode(info_block_buffer[i++]);
    }

    var info_block_obj = JSON.parse(info_block);
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

    restore_object(this, state_object, buffers);
};
