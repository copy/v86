"use strict";

/** @const */
var STATE_VERSION = 0;

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


function save_object(obj, arraybuffers)
{
    // recursively create a structure that can be json-dumped, pushing
    // arraybuffers into the second argument
    
    if(typeof obj !== "object" || obj === null || obj instanceof Array)
    {
        return obj;
    }

    if(obj.constructor === Object)
    {
        var keys = Object.keys(obj);
        var result = {};

        for(var i = 0; i < keys.length; i++)
        {
            var key = keys[i];
            result[key] = save_object(obj[key], arraybuffers);
        }

        return result;
    }

    if(obj.BYTES_PER_ELEMENT)
    {
        // Uint8Array, etc.
        return {
            __state_type__: obj.constructor.name,
            buffer_id: arraybuffers.push(obj.buffer) - 1,
        };
    }

    if(obj instanceof ArrayBuffer)
    {
        return {
            __state_type__: "ArrayBuffer",
            buffer_id: arraybuffers.push(obj) - 1,
        };
    }

    var skip = (obj._state_skip || []).setify();
    skip["_state_skip"] = true;

    var keys = Object.keys(obj);
    var result = {};

    for(var i = 0; i < keys.length; i++)
    {
        var key = keys[i];

        if(skip[key])
        {
            continue;
        }

        var value = obj[key];

        if(typeof value === "function")
        {
            continue;
        }

        result[key] = save_object(value, arraybuffers);
    }

    return result;
}

function restore_object(base, obj, buffers)
{
    // recurisvely restore obj into base
    
    if(typeof obj !== "object" || obj instanceof Array || obj === null)
    {
        return obj;
    }

    var type = obj.__state_type__;

    if(type === undefined)
    {
        var keys = Object.keys(obj);

        for(var i = 0; i < keys.length; i++)
        {
            var key = keys[i];
            base[key] = restore_object(base[key], obj[key], buffers);
        }

        if(base._state_restore)
        {
            base._state_restore();
        }

        return base;
    } 
    else if(type === "ArrayBuffer")
    {
        var info = buffers.infos[obj.buffer_id];

        if(base && base.byteLength === info.length)
        {
            new Uint8Array(base).set(new Uint8Array(buffers.full, info.offset, info.length));
        }
        else
        {
            //base = buffers.full.slice(info.offset, info.offset + info.length);
            dbg_assert(false);
        }

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

        var info = buffers.infos[obj.buffer_id];

        // avoid a new allocation if possible
        if(base && 
           base.constructor === constructor && 
           base.byteOffset === 0 &&
           base.byteLength === info.length)
        {
            new Uint8Array(base.buffer).set(
                new Uint8Array(buffers.full, info.offset, info.length), 
                base.byteOffset
            );
            return base;
        }
        else
        {
            var buf = buffers.full.slice(info.offset, info.offset + info.length);
            return new constructor(buf);
        }
    }
}

v86.prototype.save_state = function()
{
    var arraybuffers = [];
    var state = save_object(this, arraybuffers);

    var buffer_infos = [];
    var total_buffer_size = 0;

    for(var i = 0; i < arraybuffers.length; i++)
    {
        var len = arraybuffers[i].byteLength;

        buffer_infos[i] = {
            offset: total_buffer_size,
            length: len,
        };

        total_buffer_size += len;

        // align
        total_buffer_size = total_buffer_size + 3 & ~3;
    }

    var info_object = JSON.stringify({
        buffer_infos: buffer_infos,
        state: state,
    });

    var buffer_block_start = STATE_INFO_BLOCK_START + 2 * info_object.length;
    var total_size = buffer_block_start + total_buffer_size;

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

    for(var i = 0; i < arraybuffers.length; i++)
    {
        var buffer = arraybuffers[i];
        buffer_block.set(new Uint8Array(buffer), buffer_infos[i].offset);
    }

    return result;
};

v86.prototype.restore_state = function(state)
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
    var buffer_block_start = STATE_INFO_BLOCK_START + info_block_len;
    var buffer_infos = info_block_obj.buffer_infos;

    for(var i = 0; i < buffer_infos.length; i++)
    {
        buffer_infos[i].offset += buffer_block_start;
    }

    var buffers = {
        full: state,
        infos: buffer_infos,
    };

    restore_object(this, info_block_obj.state, buffers);
};
