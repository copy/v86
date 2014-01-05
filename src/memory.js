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

    // this only supports a 32 bit address space
    var memory_map_registered = new Uint8Array(1 << (32 - MMAP_BLOCK_BITS)),
        memory_map_read = [],
        memory_map_write = [];

    // managed by IO() in io.js
    this.memory_map_registered = memory_map_registered;
    this.memory_map_read = memory_map_read;
    this.memory_map_write = memory_map_write;

    dbg_assert((memory_size & MMAP_BLOCK_SIZE - 1) === 0);

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
            size = memory_map_registered[aligned_addr],
            fn = memory_map_read[aligned_addr];

        if(size & 4)
        {
            return fn(addr);
        }
        else
        {
            return fn(addr) | fn(addr + 1) << 8 | 
                    fn(addr + 2) << 16 | fn(addr + 3) << 24;
        }
    }

    function mmap_write32(addr, value)
    {
        var aligned_addr = addr >>> MMAP_BLOCK_BITS,
            size = memory_map_registered[aligned_addr],
            fn = memory_map_write[aligned_addr];

        if(size & 4)
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
