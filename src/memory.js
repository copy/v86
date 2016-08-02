"use strict";

/** @const */
var A20_MASK = ~(1 << 20);
/** @const */
var A20_MASK16 = ~(1 << 20 - 1);
/** @const */
var A20_MASK32 = ~(1 << 20 - 2);

/** @const */
var USE_A20 = false;

// called by all memory reads and writes
CPU.prototype.debug_write = function(addr, size, value)
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
CPU.prototype.debug_read = function(addr, size, is_write)
{
    if(!DEBUG)
    {
        return;
    }

    dbg_assert(typeof addr === "number");
    dbg_assert(!isNaN(addr));
};


CPU.prototype.mmap_read8 = function(addr)
{
    return this.memory_map_read8[addr >>> MMAP_BLOCK_BITS](addr);
};

CPU.prototype.mmap_write8 = function(addr, value)
{
    this.memory_map_write8[addr >>> MMAP_BLOCK_BITS](addr, value);
};

CPU.prototype.mmap_read16 = function(addr)
{
    var fn = this.memory_map_read8[addr >>> MMAP_BLOCK_BITS];

    return fn(addr) | fn(addr + 1 | 0) << 8;
};

CPU.prototype.mmap_write16 = function(addr, value)
{
    var fn = this.memory_map_write8[addr >>> MMAP_BLOCK_BITS];

    fn(addr, value & 0xFF);
    fn(addr + 1 | 0, value >> 8 & 0xFF);
};

CPU.prototype.mmap_read32 = function(addr)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;

    return this.memory_map_read32[aligned_addr](addr);
}

CPU.prototype.mmap_write32 = function(addr, value)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;

    this.memory_map_write32[aligned_addr](addr, value);
}

CPU.prototype.in_mapped_range = function(addr)
{
    return addr < 0 || addr >= 0xA0000 && addr < 0xC0000 || addr >= this.memory_size;
};

/**
 * @param {number} addr
 */
CPU.prototype.read8 = function(addr)
{
    this.debug_read(addr, 1);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

    if(this.in_mapped_range(addr))
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
CPU.prototype.read16 = function(addr)
{
    this.debug_read(addr, 2);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

    if(this.in_mapped_range(addr))
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
CPU.prototype.read_aligned16 = function(addr)
{
    dbg_assert(addr >= 0 && addr < 0x80000000);
    this.debug_read(addr << 1, 2);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK16;

    if(this.in_mapped_range(addr << 1))
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
CPU.prototype.read32s = function(addr)
{
    this.debug_read(addr, 4);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

    if(this.in_mapped_range(addr))
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
CPU.prototype.read_aligned32 = function(addr)
{
    dbg_assert(addr >= 0 && addr < 0x40000000);
    this.debug_read(addr << 2, 4);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK32;

    if(this.in_mapped_range(addr << 2))
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
CPU.prototype.write8 = function(addr, value)
{
    this.debug_write(addr, 1, value);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

    var page = addr >>> MMAP_BLOCK_BITS;

    //if(OP_TRANSLATION) this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;

    if(this.in_mapped_range(addr))
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
CPU.prototype.write16 = function(addr, value)
{
    this.debug_write(addr, 2, value);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

    var page = addr >>> MMAP_BLOCK_BITS;

    //if(OP_TRANSLATION)
    //{
    //    this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;
    //    this.mem_page_infos[addr + 1 >>> MMAP_BLOCK_BITS] |= MEM_PAGE_WRITTEN;
    //}

    if(this.in_mapped_range(addr))
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
CPU.prototype.write_aligned16 = function(addr, value)
{
    dbg_assert(addr >= 0 && addr < 0x80000000);
    this.debug_write(addr << 1, 2, value);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK16;

    var page = addr >>> MMAP_BLOCK_BITS - 1;

    //if(OP_TRANSLATION) this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;

    if(this.in_mapped_range(addr << 1))
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
CPU.prototype.write32 = function(addr, value)
{
    this.debug_write(addr, 4, value);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK;

    var page = addr >>> MMAP_BLOCK_BITS;

    //if(OP_TRANSLATION)
    //{
    //    this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;
    //    this.mem_page_infos[addr + 3 >>> MMAP_BLOCK_BITS] |= MEM_PAGE_WRITTEN;
    //}

    if(this.in_mapped_range(addr))
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

CPU.prototype.write_aligned32 = function(addr, value)
{
    dbg_assert(addr >= 0 && addr < 0x40000000);
    this.debug_write(addr << 2, 4, value);
    if(USE_A20 && !this.a20_enabled) addr &= A20_MASK32;

    var page = addr >>> MMAP_BLOCK_BITS - 2;

    //if(OP_TRANSLATION) this.mem_page_infos[page] |= MEM_PAGE_WRITTEN;

    if(this.in_mapped_range(addr << 2))
    {
        this.mmap_write32(addr << 2, value);
    }
    else
    {
        this.mem32s[addr] = value;
    }
};

/**
 * @param {Array.<number>|Uint8Array} blob
 * @param {number} offset
 */
CPU.prototype.write_blob = function(blob, offset)
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
 * @param {Array.<number>|Int32Array} blob
 * @param {number} offset
 */
CPU.prototype.write_blob32 = function(blob, offset)
{
    dbg_assert(blob && blob.length);
    this.mem32s.set(blob, offset);
};
