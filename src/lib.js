"use strict";

import { dbg_assert } from "./log.js";

// pad string with spaces on the right
export function pads(str, len)
{
    str = (str || str === 0) ? str + "" : "";
    return str.padEnd(len, " ");
}

// pad string with zeros on the left
export function pad0(str, len)
{
    str = (str || str === 0) ? str + "" : "";
    return str.padStart(len, "0");
}

// generates array given size with zeros
export function zeros(size)
{
    return Array(size).fill(0);
}

// generates [0, 1, 2, ..., size-1]
export function range(size)
{
    return Array.from(Array(size).keys());
}

export var view = function(constructor, memory, offset, length)
{
    dbg_assert(offset >= 0);
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
export function h(n, len)
{
    if(!n)
    {
        var str = "";
    }
    else
    {
        var str = n.toString(16);
    }

    return "0x" + pad0(str.toUpperCase(), len || 1);
}

export function hex_dump(buffer)
{
    function hex(n, len)
    {
        return pad0(n.toString(16).toUpperCase(), len);
    }

    const result = [];
    let offset = 0;

    for(; offset + 15 < buffer.length; offset += 16)
    {
        let line = hex(offset, 5) + "   ";

        for(let j = 0; j < 0x10; j++)
        {
            line += hex(buffer[offset + j], 2) + " ";
        }

        line += "  ";

        for(let j = 0; j < 0x10; j++)
        {
            const x = buffer[offset + j];
            line += (x >= 33 && x !== 34 && x !== 92 && x <= 126) ? String.fromCharCode(x) : ".";
        }

        result.push(line);
    }

    let line = hex(offset, 5) + "   ";

    for(; offset < buffer.length; offset++)
    {
        line += hex(buffer[offset], 2) + " ";
    }

    const remainder = offset & 0xF;
    line += "   ".repeat(0x10 - remainder);
    line += "  ";

    for(let j = 0; j < remainder; j++)
    {
        const x = buffer[offset + j];
        line += (x >= 33 && x !== 34 && x !== 92 && x <= 126) ? String.fromCharCode(x) : ".";
    }

    result.push(line);

    return "\n" + result.join("\n") + "\n";
}

/* global require */
export var get_rand_int;
if(typeof crypto !== "undefined" && crypto.getRandomValues)
{
    const rand_data = new Int32Array(1);

    get_rand_int = function()
    {
        crypto.getRandomValues(rand_data);
        return rand_data[0];
    };
}
else if(typeof require !== "undefined")
{
    /** @type {{ randomBytes: Function }} */
    const crypto = require("crypto");

    get_rand_int = function()
    {
        return crypto.randomBytes(4)["readInt32LE"](0);
    };
}
else if(typeof process !== "undefined")
    {
        import("node:" + "crypto").then(crypto => {
            get_rand_int = function()
            {
                return crypto["randomBytes"](4)["readInt32LE"](0);
            };
        });
    }
else
{
    dbg_assert(false, "Unsupported platform: No cryptographic random values");
}

export var int_log2;

if(typeof Math.clz32 === "function" && Math.clz32(0) === 32 && Math.clz32(0x12345) === 15 && Math.clz32(-1) === 0)
{
    /**
     * calculate the integer logarithm base 2
     * @param {number} x
     * @return {number}
     */
    int_log2 = function(x)
    {
        dbg_assert(x > 0);

        return 31 - Math.clz32(x);
    };
} else {

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
    int_log2 = function(x)
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
}

export const round_up_to_next_power_of_2 = function(x)
{
    dbg_assert(x >= 0);
    return x <= 1 ? 1 : 1 << 1 + int_log2(x - 1);
};

if(DEBUG)
{
    dbg_assert(int_log2(1) === 0);
    dbg_assert(int_log2(2) === 1);
    dbg_assert(int_log2(7) === 2);
    dbg_assert(int_log2(8) === 3);
    dbg_assert(int_log2(123456789) === 26);

    dbg_assert(round_up_to_next_power_of_2(0) === 1);
    dbg_assert(round_up_to_next_power_of_2(1) === 1);
    dbg_assert(round_up_to_next_power_of_2(2) === 2);
    dbg_assert(round_up_to_next_power_of_2(7) === 8);
    dbg_assert(round_up_to_next_power_of_2(8) === 8);
    dbg_assert(round_up_to_next_power_of_2(123456789) === 134217728);
}

/**
 * @constructor
 *
 * Queue wrapper around Uint8Array
 * Used by devices such as the PS2 controller
 */
export function ByteQueue(size)
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
 * @constructor
 *
 * Queue wrapper around Float32Array
 * Used by devices such as the sound blaster sound card
 */
export function FloatQueue(size)
{
    this.size = size;
    this.data = new Float32Array(size);
    this.start = 0;
    this.end = 0;
    this.length = 0;

    dbg_assert((size & size - 1) === 0);
}

FloatQueue.prototype.push = function(item)
{
    if(this.length === this.size)
    {
        // intentional overwrite
        this.start = this.start + 1 & this.size - 1;
    }
    else
    {
        this.length++;
    }

    this.data[this.end] = item;
    this.end = this.end + 1 & this.size - 1;
};

FloatQueue.prototype.shift = function()
{
    if(!this.length)
    {
        return undefined;
    }
    else
    {
        var item = this.data[this.start];

        this.start = this.start + 1 & this.size - 1;
        this.length--;

        return item;
    }
};

FloatQueue.prototype.shift_block = function(count)
{
    var slice = new Float32Array(count);

    if(count > this.length)
    {
        count = this.length;
    }
    var slice_end = this.start + count;

    var partial = this.data.subarray(this.start, slice_end);

    slice.set(partial);
    if(slice_end >= this.size)
    {
        slice_end -= this.size;
        slice.set(this.data.subarray(0, slice_end), partial.length);
    }
    this.start = slice_end;

    this.length -= count;

    return slice;
};

FloatQueue.prototype.peek = function()
{
    if(!this.length)
    {
        return undefined;
    }
    else
    {
        return this.data[this.start];
    }
};

FloatQueue.prototype.clear = function()
{
    this.start = 0;
    this.end = 0;
    this.length = 0;
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

export function dump_file(ab, name)
{
    if(!Array.isArray(ab))
    {
        ab = [ab];
    }

    var blob = new Blob(ab);
    download(blob, name);
}

export function download(file_or_blob, name)
{
    var a = document.createElement("a");
    a["download"] = name;
    a.href = window.URL.createObjectURL(file_or_blob);
    a.dataset["downloadurl"] = ["application/octet-stream", a["download"], a.href].join(":");

    if(document.createEvent)
    {
        var ev = document.createEvent("MouseEvent");
        ev.initMouseEvent("click", true, true, window,
                          0, 0, 0, 0, 0, false, false, false, false, 0, null);
        a.dispatchEvent(ev);
    }
    else
    {
        a.click();
    }

    window.URL.revokeObjectURL(a.href);
}

/**
 * A simple 1d bitmap
 * @constructor
 */
export var Bitmap = function(length_or_buffer)
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
        dbg_assert(false, "Bitmap: Invalid argument");
    }
};

Bitmap.prototype.set = function(index, value)
{
    const bit_index = index & 7;
    const byte_index = index >> 3;
    const bit_mask = 1 << bit_index;

    this.view[byte_index] =
        value ? this.view[byte_index] | bit_mask : this.view[byte_index] & ~bit_mask;
};

Bitmap.prototype.get = function(index)
{
    const bit_index = index & 7;
    const byte_index = index >> 3;

    return this.view[byte_index] >> bit_index & 1;
};

Bitmap.prototype.get_buffer = function()
{
    return this.view.buffer;
};


export var load_file;
if(typeof XMLHttpRequest === "undefined")
{
    load_file = load_file_nodejs;
}
else
{
    load_file = _load_file;
}

/**
 * @param {string} filename
 * @param {Object} options
 * @param {number=} n_tries
 */
function _load_file(filename, options, n_tries)
{
    var http = new XMLHttpRequest();

    http.open(options.method || "get", filename, true);

    if(options.as_json)
    {
        http.responseType = "json";
    }
    else
    {
        http.responseType = "arraybuffer";
    }

    if(options.headers)
    {
        var header_names = Object.keys(options.headers);

        for(var i = 0; i < header_names.length; i++)
        {
            var name = header_names[i];
            http.setRequestHeader(name, options.headers[name]);
        }
    }

    if(options.range)
    {
        const start = options.range.start;
        const end = start + options.range.length - 1;
        http.setRequestHeader("Range", "bytes=" + start + "-" + end);
        http.setRequestHeader("X-Accept-Encoding", "identity");

        // Abort if server responds with complete file in response to range
        // request, to prevent downloading large files from broken http servers
        http.onreadystatechange = function()
        {
            if(http.status === 200)
            {
                console.error("Server sent full file in response to ranged request, aborting", { filename });
                http.abort();
            }
        };
    }

    http.onload = function(e)
    {
        if(http.readyState === 4)
        {
            if(http.status !== 200 && http.status !== 206)
            {
                console.error("Loading the image " + filename + " failed (status %d)", http.status);
                if(http.status >= 500 && http.status < 600)
                {
                    retry();
                }
            }
            else if(http.response)
            {
                if(options.range)
                {
                    const enc = http.getResponseHeader("Content-Encoding");
                    if(enc && enc !== "identity")
                    {
                        console.error("Server sent Content-Encoding in response to ranged request", {filename, enc});
                    }
                }
                options.done && options.done(http.response, http);
            }
        }
    };

    http.onerror = function(e)
    {
        console.error("Loading the image " + filename + " failed", e);
        retry();
    };

    if(options.progress)
    {
        http.onprogress = function(e)
        {
            options.progress(e);
        };
    }

    http.send(null);

    function retry()
    {
        const number_of_tries = n_tries || 0;
        const timeout = [1, 1, 2, 3, 5, 8, 13, 21][number_of_tries] || 34;
        setTimeout(() => {
            load_file(filename, options, number_of_tries + 1);
        }, 1000 * timeout);
    }
}

function load_file_nodejs(filename, options)
{
    if(options.range)
    {
        dbg_assert(!options.as_json);

        import("node:" + "fs").then(fs => fs["open"](filename, "r", (err, fd) =>
            {
                if(err) throw err;

                const length = options.range.length;
                var buffer = Buffer.allocUnsafe(length);

                fs["read"](fd, buffer, 0, length, options.range.start, (err, bytes_read) =>
                    {
                        if(err) throw err;

                        dbg_assert(bytes_read === length);
                        options.done && options.done(new Uint8Array(buffer));

                        fs["close"](fd, (err) => {
                            if(err) throw err;
                        });
                    });
            }));
    }
    else
    {
        var o = {
            encoding: options.as_json ? "utf-8" : null,
        };

        import("node:" + "fs").then(fs => fs["readFile"](filename, o, function(err, data)
            {
                if(err)
                {
                    console.log("Could not read file:", filename, err);
                }
                else
                {
                    var result = data;

                    if(options.as_json)
                    {
                        result = JSON.parse(result);
                    }
                    else
                    {
                        result = new Uint8Array(result).buffer;
                    }

                    options.done(result);
                }
            }));
    }
}

// Reads len characters at offset from Memory object mem as a JS string
export function read_sized_string_from_mem(mem, offset, len)
{
    offset >>>= 0;
    len >>>= 0;
    return String.fromCharCode(...new Uint8Array(mem.buffer, offset, len));
}
