"use strict";

/** @const */
var A20_MASK = ~(1 << 20);
/** @const */
var A20_MASK16 = ~(1 << 20 - 1);
/** @const */
var A20_MASK32 = ~(1 << 20 - 2);

/** @const */
var USE_A20 = false;

/**
 * @constructor
 * @param {number} memory_size
 */
function Memory(memory_size, no_alloc)
{
    this.size = memory_size;

    // this only supports a 32 bit address space
    var size = 1 << (32 - MMAP_BLOCK_BITS);
    var memory_map_registered = new Uint8Array(size);

    // managed by IO() in io.js
    this.memory_map_registered = memory_map_registered;
    /** @const */ this.memory_map_read8 = [];
    /** @const */ this.memory_map_write8 = [];
    /** @const */ this.memory_map_read32 = [];
    /** @const */ this.memory_map_write32 = [];

    // use by dynamic translator
    //if(OP_TRANSLATION) this.mem_page_infos = new Uint8Array(1 << 20);

    dbg_assert((memory_size & MMAP_BLOCK_SIZE - 1) === 0);

    if(no_alloc)
    {
        var buffer = new ArrayBuffer(0);

        this.mem8 = new Uint8Array(buffer);
        this.mem16 = new Uint16Array(buffer);
        this.mem32s = new Int32Array(buffer);
    }
    else
    {
        var buffer = new ArrayBuffer(memory_size);

        this.mem8 = new Uint8Array(buffer);
        this.mem16 = new Uint16Array(buffer);
        this.mem32s = new Int32Array(buffer);
    }

    this.a20_enabled = true;
};

Memory.prototype.get_state = function()
{
    return [
        this.size,
        this.mem8,
    ];
}

Memory.prototype.set_state = function(state)
{
    this.size = state[0];

    this.mem8 = state[1];
    this.mem16 = new Uint16Array(this.mem8.buffer, this.mem8.byteOffset, this.mem8.length >> 1);
    this.mem32s = new Int32Array(this.mem8.buffer, this.mem8.byteOffset, this.mem8.length >> 2);
};

// called by all memory reads and writes
Memory.prototype.debug_write = function(addr, size, value)
{
    if(!DEBUG)
    {
        return;
    }

    dbg_assert(typeof value === "number" && !isNaN(value));
    dbg_assert(value >= -0x80000000 && addr < 0x80000000);

    this.debug_read(addr, size, true);
}

/**
 * @param {boolean=} is_write
 */
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

    return fn(addr) | fn(addr + 1 | 0) << 8;
};

Memory.prototype.mmap_write16 = function(addr, value)
{
    var fn = this.memory_map_write8[addr >>> MMAP_BLOCK_BITS];

    fn(addr, value & 0xFF);
    fn(addr + 1 | 0, value >> 8 & 0xFF);
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
 * @param {number} addr
 */
Memory.prototype.read8 = function(addr)
{
    this.debug_read(addr, 1);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

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
 * @param {number} addr
 */
Memory.prototype.read16 = function(addr)
{
    this.debug_read(addr, 2);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

    if(this.memory_map_registered[addr >>> MMAP_BLOCK_BITS])
    {
        return this.mmap_read16(addr);
    }
    else
    {
        return this.mem8[addr] | this.mem8[addr + 1 | 0] << 8;
    }
};

/**
 * @param {number} addr
 */
Memory.prototype.read_aligned16 = function(addr)
{
    dbg_assert(addr >= 0 && addr < 0x80000000);
    this.debug_read(addr << 1, 2);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK16;

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
 * @param {number} addr
 */
Memory.prototype.read32s = function(addr)
{
    this.debug_read(addr, 4);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

    if(this.memory_map_registered[addr >>> MMAP_BLOCK_BITS])
    {
        return this.mmap_read32(addr);
    }
    else
    {
        return this.mem8[addr] | this.mem8[addr + 1 | 0] << 8 |
            this.mem8[addr + 2 | 0] << 16 | this.mem8[addr + 3 | 0] << 24;
    }
};

/**
 * @param {number} addr
 */
Memory.prototype.read_aligned32 = function(addr)
{
    dbg_assert(addr >= 0 && addr < 0x40000000);
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
 * @param {number} addr
 * @param {number} value
 */
Memory.prototype.write8 = function(addr, value)
{
    this.debug_write(addr, 1, value);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

    var page = addr >>> MMAP_BLOCK_BITS;

    //if(OP_TRANSLATION) this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;

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
 * @param {number} addr
 * @param {number} value
 */
Memory.prototype.write16 = function(addr, value)
{
    this.debug_write(addr, 2, value);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

    var page = addr >>> MMAP_BLOCK_BITS;

    //if(OP_TRANSLATION)
    //{
    //    this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;
    //    this.mem_page_infos[addr + 1 >>> MMAP_BLOCK_BITS] |= MEM_PAGE_WRITTEN;
    //}

    if(this.memory_map_registered[page])
    {
        this.mmap_write16(addr, value);
    }
    else
    {
        this.mem8[addr] = value;
        this.mem8[addr + 1 | 0] = value >> 8;
    }
};

/**
 * @param {number} addr
 * @param {number} value
 */
Memory.prototype.write_aligned16 = function(addr, value)
{
    dbg_assert(addr >= 0 && addr < 0x80000000);
    this.debug_write(addr << 1, 2, value);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK16;

    var page = addr >>> MMAP_BLOCK_BITS - 1;

    //if(OP_TRANSLATION) this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;

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
 * @param {number} addr
 * @param {number} value
 */
Memory.prototype.write32 = function(addr, value)
{
    this.debug_write(addr, 4, value);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

    var page = addr >>> MMAP_BLOCK_BITS;

    //if(OP_TRANSLATION)
    //{
    //    this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;
    //    this.mem_page_infos[addr + 3 >>> MMAP_BLOCK_BITS] |= MEM_PAGE_WRITTEN;
    //}

    if(this.memory_map_registered[page])
    {
        this.mmap_write32(addr, value);
    }
    else
    {
        this.mem8[addr] = value;
        this.mem8[addr + 1 | 0] = value >> 8;
        this.mem8[addr + 2 | 0] = value >> 16;
        this.mem8[addr + 3 | 0] = value >> 24;
    }
};

Memory.prototype.write_aligned32 = function(addr, value)
{
    dbg_assert(addr >= 0 && addr < 0x40000000);
    this.debug_write(addr << 2, 4, value);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK32;

    var page = addr >>> MMAP_BLOCK_BITS - 2;

    //if(OP_TRANSLATION) this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;

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
 * @param {number} offset
 * @param {Array.<number>} blob
 */
Memory.prototype.write_blob = function(blob, offset)
{
    dbg_assert(blob && blob.length);

    this.mem8.set(blob, offset);

    //var page = offset >>> 12;
    //var end = (offset + blob) >>> 12;

    //if(OP_TRANSLATION)
    //{
    //    for(; page <= end; page++)
    //    {
    //        this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;
    //    }
    //}
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

