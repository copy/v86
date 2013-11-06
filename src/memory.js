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

        if((addr >= memory_size || addr < 0) && !memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
        {
            dbg_log("Read from unmapped memory space, addr=" + h(addr, 8) /*+ " at " + h(instruction_pointer, 8)*/, LOG_IO);
        }

        //dbg_assert(memory_map_registered[addr >>> MMAP_BLOCK_SIZE]);
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
         * Written as a power of 2.
         *
         * @const 
         */ 
        MMAP_BLOCK_SIZE = 14,

        /** @const */
        MMAP_BYTEWISE = 1,
        MMAP_DWORDWISE = 4,

        
        // this only supports a 32 bit address space
        memory_map_registered = new Int8Array(1 << 32 - MMAP_BLOCK_SIZE),

        memory_map_read = [],
        memory_map_write = [];

    for(var i = 0; i < (1 << 32 - MMAP_BLOCK_SIZE); i++)
    {
        // avoid sparse arrays
        memory_map_read[i] = memory_map_write[i] = undefined;
    }

    /**
     * @param addr {number}
     * @param size {number}
     * @param is_dword {boolean} true if the memory is addressed in dwords, otherwise byte
     *
     */
    this.mmap_register = function(addr, size, is_dword, read_func, write_func)
    {
        dbg_log("mmap_register32 " + h(addr, 8) + ": " + h(size, 8), LOG_IO);
        dbg_assert((addr & (1 << MMAP_BLOCK_SIZE) - 1) === 0);
        dbg_assert(size >= (1 << MMAP_BLOCK_SIZE) && (size & (1 << MMAP_BLOCK_SIZE) - 1) === 0);

        var aligned_addr = addr >>> MMAP_BLOCK_SIZE,
            unit_size = is_dword ? MMAP_DWORDWISE : MMAP_BYTEWISE;

        for(; size > 0; aligned_addr++)
        {
            memory_map_registered[aligned_addr] = unit_size;

            memory_map_read[aligned_addr] = function(read_addr)
            {
                return read_func(read_addr - addr | 0);
            };
            memory_map_write[aligned_addr] = function(write_addr, value)
            {
                write_func(write_addr - addr | 0, value);
            }            

            size -= 1 << MMAP_BLOCK_SIZE;
        }
    };

    function mmap_read8(addr)
    {
        var aligned_addr = addr >>> MMAP_BLOCK_SIZE,
            registered = memory_map_read[aligned_addr];

        //dbg_log("mmap_read8 " + h(addr, 8), LOG_IO);

        if(memory_map_registered[aligned_addr] === MMAP_BYTEWISE)
        {
            return registered(addr);
        }
        else 
        {
            return mmap_read32(addr & ~3) >> 8 * (addr & 3) & 0xFF;
        }
    };

    function mmap_write8(addr, value)
    {
        var aligned_addr = addr >>> MMAP_BLOCK_SIZE,
            registered = memory_map_write[addr >>> MMAP_BLOCK_SIZE];

        //dbg_log("mmap_write8 " + h(addr, 8) + ": " + h(value, 2), LOG_IO);

        if(memory_map_registered[aligned_addr] === MMAP_BYTEWISE)
        {
            registered(addr, value);
        }
        else
        {
            // impossible without reading. Maybe this should do nothing
            dbg_assert(false);
        }
    };

    function mmap_read32(addr)
    {
        var registered = memory_map_read[addr >>> MMAP_BLOCK_SIZE];

        //dbg_log("mmap_read32 " + h(addr, 8), LOG_IO);
        //dbg_assert((addr & 3) === 0);
        dbg_assert(registered);

        if((addr & 3) === 0 && 
                memory_map_registered[addr >>> MMAP_BLOCK_SIZE] === MMAP_DWORDWISE)
        {
            return registered(addr);
        }
        else
        {
            return mmap_read8(addr) | mmap_read8(addr + 1) << 8 |
                mmap_read8(addr + 2) << 16 | mmap_read8(addr + 3) << 24;
        }
    };

    function mmap_write32(addr, value)
    {
        var registered = memory_map_write[addr >>> MMAP_BLOCK_SIZE];

        //dbg_log("mmap_write32 " + h(addr, 8) + ": " + h(value, 8), LOG_IO);
        //dbg_assert((addr & 3) === 0);
        dbg_assert(registered);

        if((addr & 3) === 0 && 
                memory_map_registered[addr >>> MMAP_BLOCK_SIZE] === MMAP_DWORDWISE)
        {
            registered(addr, value);
        }
        else
        {
            mmap_write8(addr, value & 0xFF);
            mmap_write8(addr + 1, value >> 8 & 0xFF);
            mmap_write8(addr + 2, value >> 16 & 0xFF);
            mmap_write8(addr + 3, value >> 24 & 0xFF);
        }
    };
    
    /**
     * @param addr {number}
     */
    this.read8s = function(addr)
    {
        debug_read(addr, 1);

        if(memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
        {
            return mmap_read8(addr) << 24 >> 24;
        }
        else
        {
            return int8sarray[addr];
        }
    };
    
    /**
     * @param addr {number}
     */
    this.read8 = function(addr)
    {
        debug_read(addr, 1);

        if(memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
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

        if(memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
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
        debug_read(addr, 2);

        if(memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
        {
            return mmap_read8(addr) | mmap_read8(addr + 1) << 8;
        }
        else
        {
            return int16array[addr >> 1];
        }
    };
    
    /**
     * @param addr {number}
     */
    this.read32s = function(addr)
    {
        debug_read(addr, 4);

        if(memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
        {
            return mmap_read32(addr) | 0;
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
        debug_read(addr, 4);

        if(memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
        {
            return mmap_read32(addr) | 0;
        }
        else
        {
            return int32sarray[addr >> 2];
        }
    };
    
    /**
     * @param addr {number}
     * @param value {number}
     */
    this.write8 = function(addr, value)
    {
        debug_write(addr, 1, value);

        if(memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
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

        if(memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
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
        debug_write(addr, 2, value);

        if(memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
        {
            mmap_write8(addr, value & 0xff);
            mmap_write8(addr + 1, value >> 8 & 0xff);
        }
        else
        {
            int16array[addr >> 1] = value;
        }
    };
    
    /**
     * @param addr {number}
     * @param value {number}
     */
    this.write32 = function(addr, value)
    {
        debug_write(addr, 4, value);

        if(memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
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
        if(memory_map_registered[addr >>> MMAP_BLOCK_SIZE])
        {
            mmap_write32(addr, value);
        }
        else
        {
            int32sarray[addr >> 2] = value;
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
