
/** 
 * @param {?=} progress 
 * @param {?=} headers 
 */
function load_file(filename, done, progress, headers)
{
    var http = new XMLHttpRequest();

    http.open("get", filename, true);
    http.responseType = "arraybuffer";

    if(headers)
    {
        var header_names = Object.keys(headers);

        for(var i = 0; i < header_names.length; i++)
        {
            var name = header_names[i];

            http.setRequestHeader(name, headers[name]);
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
                done(http.response);
            }
        }
    };

    if(progress)
    {
        http.onprogress = function(e)
        {
            progress(e);
        };
    }
    
    http.send(null);
}

/**
 * @this {AsyncFileBuffer|AsyncXHRBuffer}
 * Likewise, relies on this.byteLength, this.loaded_blocks and this.block_size
 */
function async_buffer_set(offset, data, fn)
{
    console.assert(offset + data.length <= this.byteLength);
    
    var len = data.length;

    // TODO: Unaligned write
    console.assert(offset % this.block_size === 0);
    console.assert(len % this.block_size === 0);
    console.assert(len);

    var start_block = offset / this.block_size;
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
 * Asynchronous access to ArrayBuffer, loading blocks lazily as needed.
 * This is just a prototype and partly incomplete.
 *
 * @constructor
 * @param {string} filename   Name of the file to download parts
 *                            from. Replaces %d with the block number (padded)
 */
function AsyncXHRBuffer(filename, block_size, size)
{
    this.filename = filename;
    this.block_size = block_size;
    this.block_count = size / block_size;
    console.assert(this.block_count === (this.block_count | 0));

    this.loaded_blocks = {};
    
    this.byteLength = size;

    this.get_buffer = function(fn)
    {
        // We must download all parts, unlikely a good idea for big files
    };
}
AsyncXHRBuffer.prototype.get = function(offset, len, fn)
{
    console.assert(offset % this.block_size === 0);
    console.assert(len % this.block_size === 0);
    console.assert(len);

    var range_start = offset,
        range_end = offset + len - 1;

    load_file(this.filename, 
        function(buffer)
        {
            var block = new Uint8Array(buffer);
            
            this.handle_read(offset, len, block);
            fn(block);
        }.bind(this), 
        null,
        {
            Range: "bytes=" + range_start + "-" + range_end,
        }
    );
}
AsyncXHRBuffer.prototype.set = async_buffer_set;

AsyncXHRBuffer.prototype.handle_read = function(offset, len, block)
{
    // Used by AsyncXHRBuffer and AsyncFileBuffer
    // Overwrites blocks from the original source that have been written since
    
    var start_block = offset / this.block_size,
        block_count = len / this.block_size;

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

/**
 * Synchronous access to File, loading blocks from the input type=file
 * The whole file is loaded into memory during initialisation
 *
 * @constructor
 */
function SyncFileBuffer(file)
{
    var PART_SIZE = 4 << 20,
        ready = false,
        me = this;

    this.byteLength = file.size;

    if(file.size > (1 << 30))
    {
        console.log("Warning: Allocating buffer of " + (file.size >> 20) + " MB ...");
    }

    var buffer = new ArrayBuffer(file.size),
        pointer = 0,
        filereader = new FileReader();

    this.load = function()
    {
        // Here: Read all parts sequentially
        // Other option: Read all parts in parallel
        filereader.onload = function(e)
        {
            new Uint8Array(buffer, pointer).set(new Uint8Array(e.target.result));
            pointer += PART_SIZE;
            next();
        };

        next();

        function next()
        {
            if(me.onprogress)
            {
                me.onprogress({
                    loaded: pointer,   
                    total: file.size,
                    lengthComputable: true,
                });
            }

            if(pointer < file.size)
            {
                filereader.readAsArrayBuffer(file.slice(pointer, Math.min(pointer + PART_SIZE, file.size)));
            }
            else
            {
                ready = true;

                if(me.onload)
                {
                    me.onload({
                        
                    });
                }
            }
        }
    }

    this.get = function(offset, len, fn)
    {
        if(ready)
        {
            console.assert(offset + len <= buffer.byteLength);

            fn(new Uint8Array(buffer, offset, len));
        }
        else
        {
            throw "SyncFileBuffer: Wait for ready";
        }
    };

    this.get_buffer = function(fn)
    {
        if(ready)
        {
            fn(buffer);
        }
        else
        {
            throw "SyncFileBuffer: Wait for ready";
        }
    };

    /** @param data {Uint8Array] */
    this.set = function(offset, data, fn)
    {
        if(ready)
        {
            console.assert(offset + data.byteLength <= buffer.byteLength);

            new Uint8Array(buffer, offset, data.byteLength).set(data);
            fn();
        }
        else
        {
            throw "SyncFileBuffer: Wait for ready";
        }
    };
}

/**
 * Asynchronous access to File, loading blocks from the input type=file
 *
 * @constructor
 */
function AsyncFileBuffer(file)
{
    var BLOCK_SHIFT = 9,
        BLOCK_SIZE = 1 << BLOCK_SHIFT;

    this.file = file;
    this.byteLength = file.size;

    this.block_count = file.size >> BLOCK_SHIFT;
    this.block_size = BLOCK_SIZE;

    this.loaded_blocks = {};

    this.get_buffer = function(fn)
    {
    };

    this.load = function()
    {
        this.onload && this.onload({});
    };

    this._state_skip = [
        "file",
        "block_count",
        "byteLength",
        "block_size",
    ];
}
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
AsyncFileBuffer.prototype.set = async_buffer_set;
AsyncFileBuffer.prototype.handle_read = AsyncXHRBuffer.prototype.handle_read;

