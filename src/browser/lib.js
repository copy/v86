"use strict";

/** @const */
var ASYNC_SAFE = false;

(function()
{
    if(typeof XMLHttpRequest === "undefined")
    {
        v86util.load_file = load_file_nodejs;
    }
    else
    {
        v86util.load_file = load_file;
    }

    v86util.AsyncXHRBuffer = AsyncXHRBuffer;
    v86util.AsyncFileBuffer = AsyncFileBuffer;
    v86util.SyncFileBuffer = SyncFileBuffer;

    /**
     * @param {string} filename
     * @param {Object} options
     */
    function load_file(filename, options)
    {
        var http = new XMLHttpRequest();

        http.open(options.method || "get", filename, true);

        if(!options.as_text)
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
            let start = options.range.start;
            let end = start + options.range.length - 1;
            http.setRequestHeader("Range", "bytes=" + start + "-" + end);
        }

        http.onload = function(e)
        {
            if(http.readyState === 4)
            {
                if(http.status !== 200 && http.status !== 206)
                {
                    console.error("Loading the image `" + filename + "` failed (status %d)", http.status);
                }
                else if(http.response)
                {
                    options.done && options.done(http.response, http);
                }
            }
        };

        if(options.progress)
        {
            http.onprogress = function(e)
            {
                options.progress(e);
            };
        }

        http.send(null);
    }

    function load_file_nodejs(filename, options)
    {
        let fs = require("fs");

        if(options.range)
        {
            dbg_assert(!options.as_text);

            fs["open"](filename, "r", (err, fd) =>
            {
                if(err) throw err;

                let length = options.range.length;
                var buffer = new global["Buffer"](length);

                fs["read"](fd, buffer, 0, length, options.range.start, (err, bytes_read) =>
                {
                    if(err) throw err;

                    dbg_assert(bytes_read === length);
                    options.done && options.done(new Uint8Array(buffer));

                    fs["close"](fd, (err) => {
                        if(err) throw err;
                    });
                });
            });
        }
        else
        {
            var o = {
                encoding: options.as_text ? "utf-8" : null,
            };

            fs["readFile"](filename, o, function(err, data)
            {
                if(err)
                {
                    console.log("Could not read file:", filename, err);
                }
                else
                {
                    var result = data;

                    if(!options.as_text)
                    {
                        result = new Uint8Array(result).buffer;
                    }

                    options.done(result);
                }
            });
        }
    }

    if(typeof XMLHttpRequest === "undefined")
    {
        var determine_size = function(path, cb)
        {
            require("fs")["stat"](path, (err, stats) =>
            {
                if(err)
                {
                    cb(err);
                }
                else
                {
                    cb(null, stats.size);
                }
            });
        };
    }
    else
    {
        var determine_size = function(url, cb)
        {
            v86util.load_file(url, {
                done: (buffer, http) =>
                {
                    var header = http.getResponseHeader("Content-Range") || "";
                    var match = header.match(/\/(\d+)\s*$/);

                    if(match)
                    {
                        cb(null, +match[1]);
                    }
                    else
                    {
                        cb({ header });
                    }
                },
                headers: {
                    Range: "bytes=0-0",

                    //"Accept-Encoding": "",

                    // Added by Chromium, but can cause the whole file to be sent
                    // Settings this to empty also causes problems and Chromium
                    // doesn't seem to create this header any more
                    //"If-Range": "",
                }
            });
        };
    }

    /**
     * Asynchronous access to ArrayBuffer, loading blocks lazily as needed,
     * using the `Range: bytes=...` header
     *
     * @constructor
     * @param {string} filename Name of the file to download
     * @param {number|undefined} size
     */
    function AsyncXHRBuffer(filename, size)
    {
        this.filename = filename;

        /** @const */
        this.block_size = 256;
        this.byteLength = size;

        this.loaded_blocks = {};

        this.onload = undefined;
        this.onprogress = undefined;
    }

    AsyncXHRBuffer.prototype.load = function()
    {
        if(this.byteLength !== undefined)
        {
            this.onload && this.onload({});
            return;
        }

        // Determine the size using a request

        determine_size(this.filename, (error, size) =>
        {
            if(error)
            {
                console.assert(false,
                    "Cannot use: " + this.filename + ". " +
                    "`Range: bytes=...` header not supported (Got `" + error.header + "`)");
            }
            else
            {
                dbg_assert(size >= 0);
                this.byteLength = size;
                this.onload && this.onload({});
            }
        });
    };

    /**
     * @param {number} offset
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    AsyncXHRBuffer.prototype.get_from_cache = function(offset, len, fn)
    {
        var number_of_blocks = len / this.block_size;
        var block_index = offset / this.block_size;

        for(var i = 0; i < number_of_blocks; i++)
        {
            var block = this.loaded_blocks[block_index + i];

            if(!block)
            {
                return;
            }
        }

        if(number_of_blocks === 1)
        {
            return this.loaded_blocks[block_index];
        }
        else
        {
            var result = new Uint8Array(len);
            for(var i = 0; i < number_of_blocks; i++)
            {
                result.set(this.loaded_blocks[block_index + i], i * this.block_size);
            }
            return result;
        }
    };

    /**
     * @param {number} offset
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    AsyncXHRBuffer.prototype.get = function(offset, len, fn)
    {
        console.assert(offset + len <= this.byteLength);
        console.assert(offset % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        var block = this.get_from_cache(offset, len, fn);
        if(block)
        {
            if(ASYNC_SAFE)
            {
                setTimeout(fn.bind(this, block), 0);
            }
            else
            {
                fn(block);
            }
            return;
        }

        v86util.load_file(this.filename, {
            done: function done(buffer)
            {
                var block = new Uint8Array(buffer);
                this.handle_read(offset, len, block);
                fn(block);
            }.bind(this),
            range: { start: offset, length: len },
        });
    };

    /**
     * Relies on this.byteLength, this.loaded_blocks and this.block_size
     *
     * @this {AsyncFileBuffer|AsyncXHRBuffer}
     *
     * @param {number} start
     * @param {!Uint8Array} data
     * @param {function()} fn
     */
    AsyncXHRBuffer.prototype.set = function(start, data, fn)
    {
        console.assert(start + data.byteLength <= this.byteLength);

        var len = data.length;

        console.assert(start % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        var start_block = start / this.block_size;
        var block_count = len / this.block_size;

        for(var i = 0; i < block_count; i++)
        {
            var block = this.loaded_blocks[start_block + i];

            if(block === undefined)
            {
                block = this.loaded_blocks[start_block + i] = new Uint8Array(this.block_size);
            }

            var data_slice = data.subarray(i * this.block_size, (i + 1) * this.block_size);
            block.set(data_slice);

            console.assert(block.byteLength === data_slice.length);
        }

        fn();
    };

    /**
     * @this {AsyncFileBuffer|AsyncXHRBuffer}
     * @param {number} offset
     * @param {number} len
     * @param {!Uint8Array} block
     */
    AsyncXHRBuffer.prototype.handle_read = function(offset, len, block)
    {
        // Used by AsyncXHRBuffer and AsyncFileBuffer
        // Overwrites blocks from the original source that have been written since

        var start_block = offset / this.block_size;
        var block_count = len / this.block_size;

        for(var i = 0; i < block_count; i++)
        {
            var written_block = this.loaded_blocks[start_block + i];

            if(written_block)
            {
                block.set(written_block, i * this.block_size);
            }
            //else
            //{
            //    var cached = this.loaded_blocks[start_block + i] = new Uint8Array(this.block_size);
            //    cached.set(block.subarray(i * this.block_size, (i + 1) * this.block_size));
            //}
        }
    };

    AsyncXHRBuffer.prototype.get_buffer = function(fn)
    {
        // We must download all parts, unlikely a good idea for big files
        fn();
    };

    AsyncXHRBuffer.prototype.get_written_blocks = function()
    {
        var count = 0;
        for(var _ in this.loaded_blocks)
        {
            count++;
        }

        var buffer = new Uint8Array(count * this.block_size);
        var indices = [];

        var i = 0;
        for(var index in this.loaded_blocks)
        {
            var block = this.loaded_blocks[index];
            dbg_assert(block.length === this.block_size);
            index = +index;
            indices.push(index);
            buffer.set(
                block,
                i * this.block_size
            );
            i++;
        }

        return {
            buffer,
            indices,
            block_size: this.block_size,
        };
    };

    /**
     * Synchronous access to File, loading blocks from the input type=file
     * The whole file is loaded into memory during initialisation
     *
     * @constructor
     */
    function SyncFileBuffer(file)
    {
        this.file = file;
        this.byteLength = file.size;

        if(file.size > (1 << 30))
        {
            console.warn("SyncFileBuffer: Allocating buffer of " + (file.size >> 20) + " MB ...");
        }

        this.buffer = new ArrayBuffer(file.size);
        this.onload = undefined;
        this.onprogress = undefined;
    }

    SyncFileBuffer.prototype.load = function()
    {
        this.load_next(0);
    };

    /**
     * @param {number} start
     */
    SyncFileBuffer.prototype.load_next = function(start)
    {
        /** @const */
        var PART_SIZE = 4 << 20;

        var filereader = new FileReader();

        filereader.onload = function(e)
        {
            var buffer = new Uint8Array(e.target.result);
            new Uint8Array(this.buffer, start).set(buffer);
            this.load_next(start + PART_SIZE);
        }.bind(this);

        if(this.onprogress)
        {
            this.onprogress({
                loaded: start,
                total: this.byteLength,
                lengthComputable: true,
            });
        }

        if(start < this.byteLength)
        {
            var end = Math.min(start + PART_SIZE, this.byteLength);
            var slice = this.file.slice(start, end);
            filereader.readAsArrayBuffer(slice);
        }
        else
        {
            this.file = undefined;
            this.onload && this.onload({ buffer: this.buffer });
        }
    };

    /**
     * @param {number} start
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    SyncFileBuffer.prototype.get = function(start, len, fn)
    {
        console.assert(start + len <= this.byteLength);
        fn(new Uint8Array(this.buffer, start, len));
    };

    /**
     * @param {number} offset
     * @param {!Uint8Array} slice
     * @param {function()} fn
     */
    SyncFileBuffer.prototype.set = function(offset, slice, fn)
    {
        console.assert(offset + slice.byteLength <= this.byteLength);

        new Uint8Array(this.buffer, offset, slice.byteLength).set(slice);
        fn();
    };

    SyncFileBuffer.prototype.get_buffer = function(fn)
    {
        fn(this.buffer);
    };

    /**
     * Asynchronous access to File, loading blocks from the input type=file
     *
     * @constructor
     */
    function AsyncFileBuffer(file)
    {
        this.file = file;
        this.byteLength = file.size;

        /** @const */
        this.block_size = 256;
        this.loaded_blocks = {};

        this.onload = undefined;
        this.onprogress = undefined;
    }

    AsyncFileBuffer.prototype.load = function()
    {
        this.onload && this.onload({});
    };

    /**
     * @param {number} offset
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    AsyncFileBuffer.prototype.get = function(offset, len, fn)
    {
        console.assert(offset % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        var block = this.get_from_cache(offset, len, fn);
        if(block)
        {
            fn(block);
            return;
        }

        var fr = new FileReader();

        fr.onload = function(e)
        {
            var buffer = e.target.result;
            var block = new Uint8Array(buffer);

            this.handle_read(offset, len, block);
            fn(block);
        }.bind(this);

        fr.readAsArrayBuffer(this.file.slice(offset, offset + len));
    };
    AsyncFileBuffer.prototype.get_from_cache = AsyncXHRBuffer.prototype.get_from_cache;
    AsyncFileBuffer.prototype.set = AsyncXHRBuffer.prototype.set;
    AsyncFileBuffer.prototype.handle_read = AsyncXHRBuffer.prototype.handle_read;

    AsyncFileBuffer.prototype.get_buffer = function(fn)
    {
        // We must load all parts, unlikely a good idea for big files
        fn();
    };

    AsyncFileBuffer.prototype.get_as_file = function(name)
    {
        var parts = [];
        var existing_blocks = Object.keys(this.loaded_blocks)
                                .map(Number)
                                .sort(function(x, y) { return x - y; });

        var current_offset = 0;

        for(var i = 0; i < existing_blocks.length; i++)
        {
            var block_index = existing_blocks[i];
            var block = this.loaded_blocks[block_index];
            var start = block_index * this.block_size;
            console.assert(start >= current_offset);

            if(start !== current_offset)
            {
                parts.push(this.file.slice(current_offset, start));
                current_offset = start;
            }

            parts.push(block);
            current_offset += block.length;
        }

        if(current_offset !== this.file.size)
        {
            parts.push(this.file.slice(current_offset));
        }

        var file = new File(parts, name);
        console.assert(file.size === this.file.size);

        return file;
    };

})();
