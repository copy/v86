"use strict";

var v86util = v86util || {};

// pad string with spaces on the right
v86util.pads = function(str, len)
{
    str = (str || str === 0) ? str + "" : "";
    return str.padEnd(len, " ");
};

v86util.check_env_node = function()
{
    return typeof process !== "undefined" && process.versions && process.versions.node;
};

// pad string with zeros on the left
v86util.pad0 = function(str, len)
{
    str = (str || str === 0) ? str + "" : "";
    return str.padStart(len, "0");
};

// generates array given size with zeros
v86util.zeros = function(size)
{
    return Array(size).fill(0);
};

// generates [0, 1, 2, ..., size-1]
v86util.range = function(size)
{
    return Array.from(Array(size).keys());
};

v86util.view = function(constructor, memory, offset, length)
{
    return new Proxy({},
        {
            get: function(target, property, receiver)
            {
                const b = new constructor(memory.buffer, offset, length);
                const x = b[property];
                if(typeof x === "function")
                {
                    return x.bind(b);
                }
                dbg_assert(/^\d+$/.test(property) || property === "buffer" || property === "length" ||
                    property === "BYTES_PER_ELEMENT" || property === "byteOffset");
                return x;
            },
            set: function(target, property, value, receiver)
            {
                dbg_assert(/^\d+$/.test(property));
                new constructor(memory.buffer, offset, length)[property] = value;
                return true;
            },
        });
};

/**
 * number to hex
 * @param {number} n
 * @param {number=} len
 * @return {string}
 */
function h(n, len)
{
    if(!n)
    {
        var str = "";
    }
    else
    {
        var str = n.toString(16);
    }

    return "0x" + v86util.pad0(str.toUpperCase(), len || 1);
}


if(typeof window !== "undefined" && window.crypto && window.crypto.getRandomValues)
{
    let rand_data = new Int32Array(1);

    v86util.get_rand_int = function()
    {
        window.crypto.getRandomValues(rand_data);
        return rand_data[0];
    };
}
else if(typeof require !== "undefined")
{
    /** @type {{ randomBytes: Function }} */
    const crypto = require("crypto");

    v86util.get_rand_int = function()
    {
        return new Int32Array(crypto.randomBytes(4));
    };
}
else
{
    dbg_assert(false, "Unsupported platform: No cryptographic random values");
}


/**
 * Synchronous access to ArrayBuffer
 * @constructor
 */
function SyncBuffer(buffer)
{
    dbg_assert(buffer instanceof ArrayBuffer);

    this.buffer = buffer;
    this.byteLength = buffer.byteLength;
    this.onload = undefined;
    this.onprogress = undefined;
}

SyncBuffer.prototype.load = function()
{
    this.onload && this.onload({ buffer: this.buffer });
};

/**
 * @param {number} start
 * @param {number} len
 * @param {function(!Uint8Array)} fn
 */
SyncBuffer.prototype.get = function(start, len, fn)
{
    dbg_assert(start + len <= this.byteLength);
    fn(new Uint8Array(this.buffer, start, len));
};

/**
 * @param {number} start
 * @param {!Uint8Array} slice
 * @param {function()} fn
 */
SyncBuffer.prototype.set = function(start, slice, fn)
{
    dbg_assert(start + slice.byteLength <= this.byteLength);

    new Uint8Array(this.buffer, start, slice.byteLength).set(slice);
    fn();
};

/**
 * @param {function(!ArrayBuffer)} fn
 */
SyncBuffer.prototype.get_buffer = function(fn)
{
    fn(this.buffer);
};



(function()
{
    var int_log2_table = new Int8Array(256);

    for(var i = 0, b = -2; i < 256; i++)
    {
        if(!(i & i - 1))
            b++;

        int_log2_table[i] = b;
    }

    /**
     * calculate the integer logarithm base 2 of a byte
     * @param {number} x
     * @return {number}
     */
    v86util.int_log2_byte = function(x)
    {
        dbg_assert(x > 0);
        dbg_assert(x < 0x100);

        return int_log2_table[x];
    };

    /**
     * calculate the integer logarithm base 2
     * @param {number} x
     * @return {number}
     */
    v86util.int_log2 = function(x)
    {
        x >>>= 0;
        dbg_assert(x > 0);

        // http://jsperf.com/integer-log2/6
        var tt = x >>> 16;

        if(tt)
        {
            var t = tt >>> 8;
            if(t)
            {
                return 24 + int_log2_table[t];
            }
            else
            {
                return 16 + int_log2_table[tt];
            }
        }
        else
        {
            var t = x >>> 8;
            if(t)
            {
                return 8 + int_log2_table[t];
            }
            else
            {
                return int_log2_table[x];
            }
        }
    };
})();


/**
 * @constructor
 *
 * Queue wrapper around Uint8Array
 * Used by devices such as the PS2 controller
 */
function ByteQueue(size)
{
    var data = new Uint8Array(size),
        start,
        end;

    dbg_assert((size & size - 1) === 0);

    this.length = 0;

    this.push = function(item)
    {
        if(this.length === size)
        {
            // intentional overwrite
        }
        else
        {
            this.length++;
        }

        data[end] = item;
        end = end + 1 & size - 1;
    };

    this.shift = function()
    {
        if(!this.length)
        {
            return -1;
        }
        else
        {
            var item = data[start];

            start = start + 1 & size - 1;
            this.length--;

            return item;
        }
    };

    this.peek = function()
    {
        if(!this.length)
        {
            return -1;
        }
        else
        {
            return data[start];
        }
    };

    this.clear = function()
    {
        start = 0;
        end = 0;
        this.length = 0;
    };

    this.clear();
}


/**
 * Simple circular queue for logs
 *
 * @param {number} size
 * @constructor
 */
function CircularQueue(size)
{
    this.data = [];
    this.index = 0;
    this.size = size;
}

CircularQueue.prototype.add = function(item)
{
    this.data[this.index] = item;
    this.index = (this.index + 1) % this.size;
};

CircularQueue.prototype.toArray = function()
{
    return [].slice.call(this.data, this.index).concat([].slice.call(this.data, 0, this.index));
};

CircularQueue.prototype.clear = function()
{
    this.data = [];
    this.index = 0;
};

/**
 * @param {Array} new_data
 */
CircularQueue.prototype.set = function(new_data)
{
    this.data = new_data;
    this.index = 0;
};

/**
 * A simple 1d bitmap
 * @constructor
 */
v86util.Bitmap = function(length_or_buffer)
{
    if(typeof length_or_buffer === "number")
    {
        this.view = new Uint8Array(length_or_buffer + 7 >> 3);
    }
    else if(length_or_buffer instanceof ArrayBuffer)
    {
        this.view = new Uint8Array(length_or_buffer);
    }
    else
    {
        console.assert(false);
    }
};

v86util.Bitmap.prototype.set = function(index, value)
{
    const bit_index = index & 7;
    const byte_index = index >> 3;
    const bit_mask = 1 << bit_index;

    this.view[byte_index] =
        value ? this.view[byte_index] | bit_mask : this.view[byte_index] & ~bit_mask;
};

v86util.Bitmap.prototype.get = function(index)
{
    const bit_index = index & 7;
    const byte_index = index >> 3;

    return this.view[byte_index] >> bit_index & 1;
};

v86util.Bitmap.prototype.get_buffer = function()
{
    return this.view.buffer;
};
