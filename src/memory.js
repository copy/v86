"use strict";

/**
 * @constructor
 */
function Memory(buffer, memory_size)
{
    var int8array = new Uint8Array(buffer),
        int16array = new Uint16Array(buffer),
        int8sarray = new Int8Array(buffer),
        int32sarray = new Int32Array(buffer);

    this.mem8 = int8array;
    this.mem8s = int8sarray;
    this.mem32s = int32sarray;

    this.buffer = buffer;

    // debug function called by all memory reads and writes

    function debug_write(addr, size, value)
    {
        if(!DEBUG)
        {
            return;
        }

        //dbg_assert(typeof value === "number" && !isNaN(value));
        debug_read(addr, size, true);
    }

    /** @param {boolean=} is_write */
    function debug_read(addr, size, is_write)
    {
        if(!DEBUG)
        {
            return;
        }

        dbg_assert(typeof addr === "number");
        dbg_assert(!isNaN(addr));
    };

    this.dump_all = function(start, end)
    {
        start = start || 0;
        end = end || 0x100000;
        

        // textarea method: (slow)
        //var result_string = "";

        //for(var i = start; i < start + end; i++)
        //{
        //    result_string += String.fromCharCode(int8array[i]);
        //}

        //dump_text(btoa(result_string));

        // save as method:
        dump_file(buffer.slice(start, end), "memory.bin");

    };
    
    this.dump = function(addr, length)
    {
        length = length || 4 * 0x10;
        var line, byt;
        
        for(var i = 0; i < length >> 4; i++)
        {
            line = h(addr + (i << 4), 5) + "   ";

            for(var j = 0; j < 0x10; j++)
            {
                byt = this.read8(addr + (i << 4) + j);
                line += h(byt, 2) + " ";
            }

            line += "  ";

            for(j = 0; j < 0x10; j++)
            {
                byt = this.read8(addr + (i << 4) + j);
                line += (byt < 33 || byt > 126) ? "." : String.fromCharCode(byt);
            }

            dbg_log(line);
        }
    };

    this.print_memory_map = function()
    {
        var width = 0x80,
            height = 0x10,
            block_size = memory_size / width / height | 0,
            row;

        for(var i = 0; i < height; i++)
        {
            row = "0x" + h(i * width * block_size, 8) + " | ";

            for(var j = 0; j < width; j++)
            {
                var used = this.mem32s[(i * width + j) * block_size] > 0;

                row += used ? "X" : " ";
            }

            dbg_log(row);
        }
    };


    var 
        /** 
         * Arbritary value, the minimum number of bytes that can be mapped
         * by one device. This might be spec'd somewhere ...
         *
         * @const 
         */ 
        MMAP_BLOCK_BITS = 14,
        /** @const */
        MMAP_BLOCK_SIZE = 1 << MMAP_BLOCK_BITS,
        
        // this only supports a 32 bit address space
        memory_map_registered = new Int8Array(1 << (32 - MMAP_BLOCK_BITS)),

        memory_map_read = [],
        memory_map_write = [];


    dbg_assert((memory_size & MMAP_BLOCK_SIZE - 1) === 0);

    /**
     * @param addr {number}
     * @param size {number}
     *
     */
    this.mmap_register = function(addr, size, fn_size, read_func, write_func)
    {
        dbg_log("mmap_register addr=" + h(addr >>> 0, 8) + " size=" + h(size, 8) + " fn_size=" + fn_size, LOG_IO);

        dbg_assert((addr & MMAP_BLOCK_SIZE - 1) === 0);
        dbg_assert(size && (size & MMAP_BLOCK_SIZE - 1) === 0);
        dbg_assert(fn_size === 1 || fn_size === 4);

        var aligned_addr = addr >>> MMAP_BLOCK_BITS;

        for(; size > 0; aligned_addr++)
        {
            memory_map_registered[aligned_addr] = fn_size;

            memory_map_read[aligned_addr] = do_read;
            memory_map_write[aligned_addr] = do_write;

            size -= MMAP_BLOCK_SIZE;
        }

        function do_read(read_addr)
        {
            return read_func(read_addr - addr | 0);
        }

        function do_write(write_addr, value)
        {
            write_func(write_addr - addr | 0, value);
        }
    };

    for(var i = 0; (i << MMAP_BLOCK_BITS) < memory_size; i++)
    {
        // avoid sparse arrays
        memory_map_read[i] = memory_map_write[i] = undefined;
    }

    this.mmap_register(memory_size, 0x100000000 - memory_size, 1,
        function(addr) {
            // read outside of the memory size
            addr += memory_size;
            dbg_log("Read from unmapped memory space, addr=" + h(addr >>> 0, 8), LOG_IO);
            return 0xFF;
        },
        function(addr, value) {
            // write outside of the memory size
            addr += memory_size;
            dbg_log("Write to unmapped memory space, addr=" + h(addr >>> 0, 8) + " value=" + h(value, 2), LOG_IO);
        });

    function mmap_read8(addr)
    {
        return memory_map_read[addr >>> MMAP_BLOCK_BITS](addr);
    }

    function mmap_write8(addr, value)
    {
        memory_map_write[addr >>> MMAP_BLOCK_BITS](addr, value);
    }

    function mmap_read32(addr)
    {
        var aligned_addr = addr >>> MMAP_BLOCK_BITS,
            fn = memory_map_read[aligned_addr];

        if(memory_map_registered[aligned_addr] === 4)
        {
            return fn(addr);
        }
        else
        {
            return fn(addr) | fn(addr + 1) << 8 | fn(addr + 2) << 16 | fn(addr + 3) << 24;
        }
    }

    function mmap_write32(addr, value)
    {
        var aligned_addr = addr >>> MMAP_BLOCK_BITS,
            fn = memory_map_write[aligned_addr];

        if(memory_map_registered[aligned_addr] === 4)
        {
            fn(addr, value);
        }
        else
        {
            fn(addr, value & 0xFF);
            fn(addr + 1, value >> 8 & 0xFF);
            fn(addr + 2, value >> 16 & 0xFF);
            fn(addr + 3, value >>> 24);
        }
    }
    
    /**
     * @param addr {number}
     */
    this.read8 = function(addr)
    {
        debug_read(addr, 1);

        if(memory_map_registered[addr >>> MMAP_BLOCK_BITS])
        {
            return mmap_read8(addr);
        }
        else
        {
            return int8array[addr];
        }
    };
    
    /**
     * @param addr {number}
     */
    this.read16 = function(addr)
    {
        debug_read(addr, 2);

        if(memory_map_registered[addr >>> MMAP_BLOCK_BITS])
        {
            return mmap_read8(addr) | mmap_read8(addr + 1) << 8;
        }
        else
        {
            return int8array[addr] | int8array[addr + 1] << 8;
        }
    };

    /**
     * @param addr {number}
     */
    this.read_aligned16 = function(addr)
    {
        debug_read(addr << 1, 2);

        if(memory_map_registered[addr >>> MMAP_BLOCK_BITS - 1])
        {
            addr <<= 1;
            return mmap_read8(addr) | mmap_read8(addr + 1) << 8;
        }
        else
        {
            return int16array[addr];
        }
    };
    
    /**
     * @param addr {number}
     */
    this.read32s = function(addr)
    {
        debug_read(addr, 4);

        if(memory_map_registered[addr >>> MMAP_BLOCK_BITS])
        {
            return mmap_read32(addr);
        }
        else
        {
            return int8array[addr] | int8array[addr + 1] << 8 | 
                int8array[addr + 2] << 16 | int8array[addr + 3] << 24;
        }
    };
    
    /**
     * @param addr {number}
     */
    this.read_aligned32 = function(addr)
    {
        debug_read(addr << 2, 4);

        if(memory_map_registered[addr >>> MMAP_BLOCK_BITS - 2])
        {
            return mmap_read32(addr << 2);
        }
        else
        {
            return int32sarray[addr];
        }
    };
    
    /**
     * @param addr {number}
     * @param value {number}
     */
    this.write8 = function(addr, value)
    {
        debug_write(addr, 1, value);

        if(memory_map_registered[addr >>> MMAP_BLOCK_BITS])
        {
            mmap_write8(addr, value);
        }
        else
        {
            int8array[addr] = value;
        }
    };
    
    /**
     * @param addr {number}
     * @param value {number}
     */
    this.write16 = function(addr, value)
    {
        debug_write(addr, 2, value);

        if(memory_map_registered[addr >>> MMAP_BLOCK_BITS])
        {
            mmap_write8(addr, value & 0xff);
            mmap_write8(addr + 1, value >> 8 & 0xff);
        }
        else
        {
            int8array[addr] = value;
            int8array[addr + 1] = value >> 8;
        }
    };
    
    /**
     * @param addr {number}
     * @param value {number}
     */
    this.write_aligned16 = function(addr, value)
    {
        debug_write(addr << 1, 2, value);

        if(memory_map_registered[addr >>> MMAP_BLOCK_BITS - 1])
        {
            addr <<= 1;
            mmap_write8(addr, value & 0xff);
            mmap_write8(addr + 1, value >> 8 & 0xff);
        }
        else
        {
            int16array[addr] = value;
        }
    };
    
    /**
     * @param addr {number}
     * @param value {number}
     */
    this.write32 = function(addr, value)
    {
        debug_write(addr, 4, value);

        if(memory_map_registered[addr >>> MMAP_BLOCK_BITS])
        {
            mmap_write32(addr, value);
        }
        else
        {
            int8array[addr] = value;
            int8array[addr + 1] = value >> 8;
            int8array[addr + 2] = value >> 16;
            int8array[addr + 3] = value >> 24;
        }
    };

    this.write_aligned32 = function(addr, value)
    {
        debug_write(addr << 2, 4, value);

        if(memory_map_registered[addr >>> MMAP_BLOCK_BITS - 2])
        {
            mmap_write32(addr << 2, value);
        }
        else
        {
            int32sarray[addr] = value;
        }
    };

    /**
     * @param offset {number}
     * @param blob {Array.<number>}
     */
    this.write_blob = function(blob, offset)
    {
        dbg_assert(blob && blob.length);
        int8array.set(blob, offset);
    };

    /**
     * zero byte terminated string
     */
    this.read_string = function(addr)
    {
        var str = "",
            data_byte;

        while(data_byte = this.read8(addr))
        {
            str += String.fromCharCode(data_byte);
            addr++;
        }

        return str;
    };

    this.write_string = function(str, addr)
    {
        for(var i = 0; i < str.length; i++)
        {
            this.write8(addr + i, str.charCodeAt(i));
        }
    };
}
