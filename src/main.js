"use strict";

/** @define {boolean} */
var IN_NODE = false;

/** @define {boolean} */
var IN_WORKER = false;

/** @define {boolean} */
var IN_BROWSER = true;


if(IN_BROWSER + IN_NODE + IN_WORKER !== 1)
{
    throw "Invalid environment";
}

Object.fromList = function(xs)
{
    var result = {};

    for(var i = 0; i < xs.length; i++)
    {
        result[xs[i][0]] = xs[i][1];
    }

    return result;
};

var dbg_names = Object.fromList([
    [1, ""],
    [LOG_CPU, "CPU"],
    [LOG_DISK, "DISK"],
    [LOG_FPU, "FPU"],
    [LOG_MEM, "MEM"],
    [LOG_DMA, "DMA"],
    [LOG_IO, "IO"],
    [LOG_PS2, "PS2"],
    [LOG_PIC, "PIC"],
    [LOG_VGA, "VGA"],
    [LOG_PIT, "PIT"],
    [LOG_MOUSE, "MOUS"],
    [LOG_PCI, "PCI"],
    [LOG_BIOS, "BIOS"],
    [LOG_CD, "CD"],
    [LOG_SERIAL, "SERI"],
    [LOG_RTC, "RTC"],
    [LOG_HPET, "HPET"],
    [LOG_ACPI, "ACPI"],
    [LOG_APIC, "APIC"],
    [LOG_NET, "NET"],
]);


var log_last_message = "",
    log_message_repetitions = 0;

/** 
 * @param {number=} level
 */
function dbg_log(stuff, level)
{
    if(!DEBUG) return;

    level = level || 1;

    if(level & LOG_LEVEL)
    {
        var level_name = dbg_names[level] || "",
            message = "[" + String.pads(level_name, 4) + "] " + stuff;

        if(message === log_last_message)
        {
            log_message_repetitions++;

            if(log_message_repetitions < 2048)
            {
                return;
            }
        }

        if(log_message_repetitions)
        {
            if(log_message_repetitions === 1)
            {
                console.log(log_last_message);
            }
            else 
            {
                console.log("Previous message repeated " + log_message_repetitions + " times");;
            }

            log_message_repetitions = 0;
        }

        console.log(message);

        log_last_message = message;
    }
}

/** 
 * @param {number=} level
 */
function dbg_trace(level)
{
    if(!DEBUG) return;

    dbg_log(Error().stack, level);
}

/** 
 * console.assert is fucking slow
 * @param {string=} msg
 * @param {number=} level
 */
function dbg_assert(cond, msg, level) 
{ 
    if(!DEBUG) return;

    if(!cond) 
    { 
        //dump_regs();
        console.log(Error().stack);
        console.trace();

        if(msg)
        {
            throw "Assert failed: " + msg;
        }
        else
        {
            throw "Assert failed";
        }
    } 
};


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
 * @param {number=} len
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
    this.byteLength = buffer.byteLength;

    // warning: fn may be called synchronously or asynchronously
    this.get = function(start, len, fn)
    {
        dbg_assert(start + len <= buffer.byteLength);

        fn(new Uint8Array(buffer, start, len));
    };

    this.set = function(start, slice, fn)
    {
        dbg_assert(start + slice.length <= buffer.byteLength);

        new Uint8Array(buffer, start, slice.byteLength).set(slice);
        fn();
    };

    this.get_buffer = function(fn)
    {
        fn(buffer);
    };
}
if(typeof window === "object")
{
    window["SyncBuffer"] = SyncBuffer;
}

/**
 * Simple circular queue for logs
 *
 * @param {number} size
 * @constructor
 */
function CircularQueue(size)
{
    var data,
        index;

    this.add = function(item)
    {
        data[index] = item;

        index = (index + 1) % size;
    };

    this.toArray = function()
    {
        return [].slice.call(data, index).concat([].slice.call(data, 0, index));
    };

    this.clear = function()
    {
        data = [];

        index = 0;
    };

    this.set = function(new_data)
    {
        data = new_data;
        index = 0;
    };


    this.clear();
}

Math.int_log2 = function(x)
{
    dbg_assert(x > 0);

    // well optimized in modern browsers, http://jsperf.com/integer-log2/2
    return (Math.log(x) / Math.LN2) | 0;
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

Array.prototype.setify = function()
{
    var set = {};

    for(var i = 0; i < this.length; i++)
    {
        set[this[i]] = true;
    }
    
    return set;
};
