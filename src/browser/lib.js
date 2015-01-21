"use strict";

(function()
{
    v86util.load_file = load_file;

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

        http.onload = function(e)
        {
            if(http.readyState === 4)
            {
                if(http.status !== 200 && http.status !== 206)
                {
                    console.log("Loading the image `" + filename + "` failed");
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

        load_file(this.filename, {
            done: function done(buffer, http)
            {
                var header = http.getResponseHeader("Content-Range") || "";
                var match = header.match(/\/(\d+)\s*$/);

                if(match)
                {
                    this.byteLength = +match[1]
                    this.onload && this.onload({});
                }
                else
                {
                    console.assert(false, 
                        "Cannot use: " + this.filename + ". " +
                        "`Range: bytes=...` header not supported");
                }
            }.bind(this), 
            headers: {
                Range: "bytes=0-0",
            }
        });
    }

    /** 
     * @param {number} offset
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    AsyncXHRBuffer.prototype.get = function(offset, len, fn)
    {
        console.assert(offset % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        var range_start = offset;
        var range_end = offset + len - 1;

        load_file(this.filename, {
            done: function done(buffer)
            {
                var block = new Uint8Array(buffer);
                this.handle_read(offset, len, block);
                fn(block);
            }.bind(this), 
            headers: {
                Range: "bytes=" + range_start + "-" + range_end,
            }
        });
    }

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
    }

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
    }

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
    }

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
        this.block_size = 256
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

        var fr = new FileReader();

        fr.onload = function(e)
        {
            var buffer = e.target.result;
            var block = new Uint8Array(buffer);

            this.handle_read(offset, len, block);
            fn(block);
        }.bind(this);

        fr.readAsArrayBuffer(this.file.slice(offset, offset + len));
    }
    AsyncFileBuffer.prototype.set = AsyncXHRBuffer.prototype.set;
    AsyncFileBuffer.prototype.handle_read = AsyncXHRBuffer.prototype.handle_read;

    AsyncFileBuffer.prototype.get_buffer = function(fn)
    {
        // We must load all parts, unlikely a good idea for big files
        fn();
    };

})();
