
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
 * @this {AsyncFileBuffer}
 * A function set on the protoype of asynchronous buffers (such as AsyncXHRBuffer)
 * Relies on this.load_block and this.block_size
 * Warning: fn may be called synchronously or asynchronously
 */
function async_buffer_get(offset, len, fn)
{
    // TODO: Unaligned read
    console.assert(offset % this.block_size === 0);
    console.assert(len % this.block_size === 0);
    console.assert(len);

    var block_size = this.block_size,
        blocks_to_load = len / block_size,
        data,
        loaded_count = 0,
        start_block = offset / block_size;

    if(blocks_to_load > 1)
    {
        // copy blocks in this buffer if there is more than one
        data = new Uint8Array(len);
    }

    for(var i = start_block; i < start_block + blocks_to_load; i++)
    {
        this.load_block(i, block_loaded);
    }

    function block_loaded(buffer, i)
    {
        var block = new Uint8Array(buffer);
        loaded_count++;

        if(blocks_to_load === 1)
        {
            data = block;
        }
        else
        {
            data.set(block, (i - start_block) * block_size);
        }

        if(loaded_count === blocks_to_load)
        {
            fn(data);
        }
    }
}

/**
 * @this {AsyncFileBuffer}
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
            block = this.loaded_blocks[start_block + i] = new ArrayBuffer(this.block_size);
        }

        var data_slice = data.subarray(i * this.block_size, (i + 1) * this.block_size);
        new Uint8Array(block).set(data_slice);

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
    this.block_size = block_size;
    this.block_count = size / block_size;
    console.assert(this.block_count === (this.block_count | 0));

    this.loaded_blocks = [];
    for(var i = 0; i < this.block_count; i++)
    {
        this.loaded_blocks[i] = undefined;
    }
    
    this.byteLength = size;

    // can be called to preload a block into the cache
    this.load_block = function(i, fn)
    {
        var cached_block = this.loaded_blocks[i];

        if(cached_block === undefined)
        {
            var me = this;

            // use Range: bytes=... to load slices of a file
            var range_start = i * block_size,
                range_end = range_start + block_size - 1;

            load_file(filename, 
                function(buffer)
                {
                    console.assert(buffer.byteLength === block_size);

                    me.loaded_blocks[i] = buffer;
                    fn(buffer, i);
                }, 
                null,
                {
                    Range: "bytes=" + range_start + "-" + range_end,
                }
            );
        }
        else
        {
            fn(cached_block, i);
        }
    };

    this.get_buffer = function(fn)
    {
        // We must download all parts, unlikely a good idea for big files
    };
}
AsyncXHRBuffer.prototype.get = async_buffer_get;
AsyncXHRBuffer.prototype.set = async_buffer_set;

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

    this.loaded_blocks = [];
    for(var i = 0; i < this.block_count; i++)
    {
        this.loaded_blocks[i] = undefined;
    }

    this.load_block = function(i, fn)
    {
        var cached_block = this.loaded_blocks[i];

        if(cached_block === undefined)
        {
            var fr = new FileReader();
            var me = this;

            fr.onload = function(e)
            {
                var buffer = e.target.result;

                me.loaded_blocks[i] = buffer;
                fn(buffer, i);
            };

            fr.readAsArrayBuffer(file.slice(i * this.block_size, (i + 1) * this.block_size));
        }
        else
        {
            fn(cached_block, i);
        }
    };

    this.get_buffer = function(fn)
    {
    };

    this.load = function()
    {
        this.onload && this.onload({});
    };
}
AsyncFileBuffer.prototype.get = function(offset, len, fn)
{
    console.assert(offset % this.block_size === 0);
    console.assert(len % this.block_size === 0);
    console.assert(len);

    var fr = new FileReader();
    var me = this;

    fr.onload = function(e)
    {
        var buffer = e.target.result;

        //me.loaded_blocks[i] = buffer;
        fn(new Uint8Array(buffer));
    };

    fr.readAsArrayBuffer(this.file.slice(offset, offset + len));
}
//AsyncFileBuffer.prototype.get = async_buffer_get;
AsyncFileBuffer.prototype.set = async_buffer_set;

