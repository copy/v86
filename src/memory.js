"use strict";

/**
 * @constructor
 * @param {number} memory_size
 */
function Memory(memory_size)
{
    this.size = memory_size;

    // this only supports a 32 bit address space
    var size = 1 << (32 - MMAP_BLOCK_BITS);
    var memory_map_registered = new Uint8Array(size);

    // managed by IO() in io.js
    /** @const */ this.memory_map_registered = memory_map_registered;
    /** @const */ this.memory_map_read8 = [];
    /** @const */ this.memory_map_write8 = [];
    /** @const */ this.memory_map_read32 = [];
    /** @const */ this.memory_map_write32 = [];

    // use by dynamic translator
    if(OP_TRANSLATION) this.mem_page_infos = new Uint8Array(1 << 20);

    dbg_assert((memory_size & MMAP_BLOCK_SIZE - 1) === 0);

    this.buffer = new ArrayBuffer(memory_size);
    this._state_restore();
};

Memory.prototype._state_restore = function()
{
    /** @const */
    this.mem8 = new Uint8Array(this.buffer);

    /** @const */
    this.mem16 = new Uint16Array(this.buffer);

    /** @const */
    this.mem32s = new Int32Array(this.buffer);

    /** @const */
    this._state_skip = [
        this.mem8,
        this.mem16,
        this.mem32s,

        this.memory_map_registered,
        this.memory_map_read8,
        this.memory_map_read32,
        this.memory_map_write8,
        this.memory_map_write32,
    ];
};

// called by all memory reads and writes
Memory.prototype.debug_write = function(addr, size, value)
{
    if(!DEBUG)
    {
        return;
    }

    //dbg_assert(typeof value === "number" && !isNaN(value));
    this.debug_read(addr, size, true);
}

/** @param {boolean=} is_write */
Memory.prototype.debug_read = function(addr, size, is_write)
{
    if(!DEBUG)
    {
        return;
    }

    dbg_assert(typeof addr === "number");
    dbg_assert(!isNaN(addr));
};


Memory.prototype.mmap_read8 = function(addr)
{
    return this.memory_map_read8[addr >>> MMAP_BLOCK_BITS](addr);
};

Memory.prototype.mmap_write8 = function(addr, value)
{
    this.memory_map_write8[addr >>> MMAP_BLOCK_BITS](addr, value);
};

Memory.prototype.mmap_read16 = function(addr)
{
    var fn = this.memory_map_read8[addr >>> MMAP_BLOCK_BITS];

    return fn(addr) | fn(addr + 1) << 8;
};

Memory.prototype.mmap_write16 = function(addr, value)
{
    var fn = this.memory_map_write8[addr >>> MMAP_BLOCK_BITS];

    fn(addr, value & 0xFF);
    fn(addr + 1, value >> 8 & 0xFF);
};

Memory.prototype.mmap_read32 = function(addr)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;

    return this.memory_map_read32[aligned_addr](addr);
}

Memory.prototype.mmap_write32 = function(addr, value)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;

    this.memory_map_write32[aligned_addr](addr, value);
}

/**
 * @param addr {number}
 */
Memory.prototype.read8 = function(addr)
{
    this.debug_read(addr, 1);

    if(this.memory_map_registered[addr >>> MMAP_BLOCK_BITS])
    {
        return this.mmap_read8(addr);
    }
    else
    {
        return this.mem8[addr];
    }
};

/**
 * @param addr {number}
 */
Memory.prototype.read16 = function(addr)
{
    this.debug_read(addr, 2);

    if(this.memory_map_registered[addr >>> MMAP_BLOCK_BITS])
    {
        return this.mmap_read16(addr);
    }
    else
    {
        return this.mem8[addr] | this.mem8[addr + 1] << 8;
    }
};

/**
 * @param addr {number}
 */
Memory.prototype.read_aligned16 = function(addr)
{
    this.debug_read(addr << 1, 2);

    if(this.memory_map_registered[addr >>> MMAP_BLOCK_BITS - 1])
    {
        return this.mmap_read16(addr << 1);
    }
    else
    {
        return this.mem16[addr];
    }
};

/**
 * @param addr {number}
 */
Memory.prototype.read32s = function(addr)
{
    this.debug_read(addr, 4);

    if(this.memory_map_registered[addr >>> MMAP_BLOCK_BITS])
    {
        return this.mmap_read32(addr);
    }
    else
    {
        return this.mem8[addr] | this.mem8[addr + 1] << 8 | 
            this.mem8[addr + 2] << 16 | this.mem8[addr + 3] << 24;
    }
};

/**
 * @param addr {number}
 */
Memory.prototype.read_aligned32 = function(addr)
{
    this.debug_read(addr << 2, 4);

    if(this.memory_map_registered[addr >>> MMAP_BLOCK_BITS - 2])
    {
        return this.mmap_read32(addr << 2);
    }
    else
    {
        return this.mem32s[addr];
    }
};

/**
 * @param addr {number}
 * @param value {number}
 */
Memory.prototype.write8 = function(addr, value)
{
    this.debug_write(addr, 1, value);

    var page = addr >>> MMAP_BLOCK_BITS;

    if(OP_TRANSLATION) this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;

    if(this.memory_map_registered[page])
    {
        this.mmap_write8(addr, value);
    }
    else
    {
        this.mem8[addr] = value;
    }
};

/**
 * @param addr {number}
 * @param value {number}
 */
Memory.prototype.write16 = function(addr, value)
{
    this.debug_write(addr, 2, value);

    var page = addr >>> MMAP_BLOCK_BITS;

    if(OP_TRANSLATION) 
    {
        this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;
        this.mem_page_infos[addr + 1 >>> MMAP_BLOCK_BITS] |= MEM_PAGE_WRITTEN;
    }

    if(this.memory_map_registered[page])
    {
        this.mmap_write16(addr, value);
    }
    else
    {
        this.mem8[addr] = value;
        this.mem8[addr + 1] = value >> 8;
    }
};

/**
 * @param addr {number}
 * @param value {number}
 */
Memory.prototype.write_aligned16 = function(addr, value)
{
    this.debug_write(addr << 1, 2, value);

    var page = addr >>> MMAP_BLOCK_BITS - 1;

    if(OP_TRANSLATION) this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;

    if(this.memory_map_registered[page])
    {
        this.mmap_write16(addr << 1, value);
    }
    else
    {
        this.mem16[addr] = value;
    }
};

/**
 * @param addr {number}
 * @param value {number}
 */
Memory.prototype.write32 = function(addr, value)
{
    this.debug_write(addr, 4, value);

    var page = addr >>> MMAP_BLOCK_BITS;

    if(OP_TRANSLATION) 
    {
        this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;
        this.mem_page_infos[addr + 3 >>> MMAP_BLOCK_BITS] |= MEM_PAGE_WRITTEN;
    }

    if(this.memory_map_registered[page])
    {
        this.mmap_write32(addr, value);
    }
    else
    {
        this.mem8[addr] = value;
        this.mem8[addr + 1] = value >> 8;
        this.mem8[addr + 2] = value >> 16;
        this.mem8[addr + 3] = value >> 24;
    }
};

Memory.prototype.write_aligned32 = function(addr, value)
{
    this.debug_write(addr << 2, 4, value);

    var page = addr >>> MMAP_BLOCK_BITS - 2;

    if(OP_TRANSLATION) this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;

    if(this.memory_map_registered[page])
    {
        this.mmap_write32(addr << 2, value);
    }
    else
    {
        this.mem32s[addr] = value;
    }
};

/**
 * @param offset {number}
 * @param blob {Array.<number>}
 */
Memory.prototype.write_blob = function(blob, offset)
{
    dbg_assert(blob && blob.length);

    this.mem8.set(blob, offset);

    var page = offset >>> 12,
        end = (offset + blob) >>> 12;

    if(OP_TRANSLATION)
    {
        for(; page <= end; page++)
        {
            this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;
        }
    }
};

/**
 * zero byte terminated string
 */
Memory.prototype.read_string = function(addr)
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

Memory.prototype.write_string = function(str, addr)
{
    for(var i = 0; i < str.length; i++)
    {
        this.write8(addr + i, str.charCodeAt(i));
    }
};

