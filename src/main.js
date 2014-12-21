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


/** @constructor */
function v86()
{
    /** @type {boolean} */
    this.first_init = true;

    /** @type {boolean} */
    this.running = false;

    /** @type {boolean} */
    this.stopped = false;

    /** @type {CPU} */
    this.cpu = new CPU();

    this.next_tick = function() {};
    this.microtick = function() {};
}

v86.prototype.run = function() 
{
    if(!this.running)
    {
        this.next_tick();
    }
};

v86.prototype.do_tick = function() 
{
    if(this.stopped)
    {
        this.stopped = this.running = false;
        return;
    }

    this.running = true;
    this.cpu.main_run();

    this.next_tick();
};

v86.prototype.stop = function()
{
    if(this.running)
    {
        this.stopped = true;
    }
};

v86.prototype.restart = function()
{
    this.cpu.reset();
    this.cpu.load_bios();
};

v86.prototype.init = function(settings)
{
    if(this.first_init)
    {
        this.first_init = false;
        this.lazy_init();
    }

    this.cpu.init(settings);
};

// initialization that only needs to be once
v86.prototype.lazy_init = function()
{
    var emulator = this;

    if(typeof setImmediate !== "undefined")
    {
        this.next_tick = function()
        {
            setImmediate(function() { emulator.do_tick(); });
        };
    }
    else if(typeof window !== "undefined" && typeof postMessage !== "undefined")
    {
        // setImmediate shim for the browser.
        // TODO: Make this deactivatable, for other applications
        //       using postMessage

        /** @const */
        var MAGIC_POST_MESSAGE = 0xAA55;

        window.addEventListener("message", function(e)
        {
            if(e.source === window && e.data === MAGIC_POST_MESSAGE)
            {
                emulator.do_tick();
            }
        }, false);

        this.next_tick = function()
        {
            window.postMessage(MAGIC_POST_MESSAGE, "*");
        };
    }
    else
    {
        this.next_tick = function()
        {
            setTimeout(function() { emulator.do_tick(); }, 0);
        };
    }

};

if(typeof performance === "object" && performance.now)
{
    v86.microtick = function()
    {
        return performance.now();
    };
}
else
{
    v86.microtick = Date.now;
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
    [LOG_VIRTIO, "VIO"],
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

Array.setify = function(array)
{
    var set = {};

    for(var i = 0; i < array.length; i++)
    {
        set[array[i]] = true;
    }
    
    return set;
};
