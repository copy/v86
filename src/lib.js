"use strict";

// pad string with spaces on the right
String.pads = function(str, len)
{
    str = str ? str + "" : "";

    while(str.length < len)
    {
        str = str + " ";
    }
    
    return str;
}

// pad string with zeros on the left
String.pad0 = function(str, len)
{
    str = str ? str + "" : "";

    while(str.length < len)
    {
        str = "0" + str;
    }
    
    return str;
}

/**
 * number to hex
 * @param {number} n
 * @param {number=} len
 * @return {string}
 */
function h(n, len)
{
    //dbg_assert(typeof n === "number");

    if(!n) return String.pad0("", len || 1);

    if(len)
    {
        return String.pad0(n.toString(16).toUpperCase(), len);
    }
    else
    {
        return n.toString(16).toUpperCase();
    }
}

/** 
 * Synchronous access to ArrayBuffer
 * @constructor
 */
function SyncBuffer(buffer)
{
    this.buffer = buffer;
    this.byteLength = buffer.byteLength;
}

/** 
 * @param {number} start
 * @param {number} len
 * @param {function(!Uint8Array)} fn
 */
SyncBuffer.prototype.get = function(start, len, fn)
{
    // warning: fn may be called synchronously or asynchronously
    dbg_assert(start + len <= this.buffer.byteLength);

    fn(new Uint8Array(this.buffer, start, len));
};

/** 
 * @param {number} start
 * @param {!Uint8Array} slice
 * @param {function()} fn
 */
SyncBuffer.prototype.set = function(start, slice, fn)
{
    dbg_assert(start + slice.length <= this.buffer.byteLength);

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


var int_log2_table = new Int8Array(256);

for(var i = 0, b = -2; i < 256; i++)
{
    if(!(i & i - 1))
        b++;

    int_log2_table[i] = b;
}

/**
 * calculate the integer logarithm base 2
 * @param {number} x
 * @return {number}
 */
Math.int_log2 = function(x)
{
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
}


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

