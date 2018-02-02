"use strict";


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
};

CPU.prototype.mmap_write32 = function(addr, value)
{
    var aligned_addr = addr >>> MMAP_BLOCK_BITS;

    this.memory_map_write32[aligned_addr](addr, value);
};

/**
 * @param {Array.<number>|Uint8Array} blob
 * @param {number} offset
 */
CPU.prototype.write_blob = function(blob, offset)
{
    dbg_assert(blob && blob.length >= 0);
    dbg_assert(!this.in_mapped_range(offset));
    dbg_assert(!this.in_mapped_range(offset + blob.length));

    this.wm.exports["_jit_dirty_cache"](offset, offset + blob.length);
    this.mem8.set(blob, offset);
};
