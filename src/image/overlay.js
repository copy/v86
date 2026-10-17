// The guest's writes to a disk image (docs/disk-image-formats-plan.md P0):
// in memory, by the offset the guest sees (not the container file's), in
// 256-byte blocks (the smallest the emulated hardware writes: no write ever
// updates part of a block) packed into 16 MiB chunks, as the lazily loaded
// RAW disks of src/buffer.js keep them (the reasons are in docs/sata.md,
// "Disk backends"). Written blocks are never evicted: past the budget a
// write fails.

import { DiskImageError } from "./source.js";

export const OVERLAY_BLOCK_SIZE = 256;

// blocks in a chunk (16 MiB)
const CHUNK_BLOCKS = 0x10000;

/**
 * @constructor
 * @param {number} byte_length the disk's size
 * @param {number=} limit the most bytes written that are kept (Infinity)
 * @param {string=} name
 */
export function WriteOverlay(byte_length, limit, name)
{
    this.byte_length = byte_length;
    this.limit = limit === undefined ? Infinity : limit;
    this.name = name || "disk";
    /** @type {!Map<number, number>} block number -> slot in the chunks */
    this.blocks = new Map();
    /** @type {!Array<!Uint8Array>} */
    this.chunks = [];
    /** @type {!Array<!Uint8Array>} chunks allocated for the write in progress */
    this.spare_chunks = [];
}

/** @return {number} the bytes written so far */
WriteOverlay.prototype.size = function()
{
    return this.blocks.size * OVERLAY_BLOCK_SIZE;
};

/**
 * The data of a written block
 * @param {number} index
 * @return {!Uint8Array|undefined}
 */
WriteOverlay.prototype.block = function(index)
{
    const slot = this.blocks.get(index);
    if(slot === undefined) return undefined;
    const offset = slot % CHUNK_BLOCKS * OVERLAY_BLOCK_SIZE;
    return this.chunks[Math.floor(slot / CHUNK_BLOCKS)].subarray(offset, offset + OVERLAY_BLOCK_SIZE);
};

/**
 * Write `data` at `offset` (both multiples of the block size): nothing is
 * written if the budget does not allow all of it
 * @param {number} offset
 * @param {!Uint8Array} data
 * @return {Error|undefined}
 */
WriteOverlay.prototype.write = function(offset, data)
{
    const length = data.length;
    if(offset % OVERLAY_BLOCK_SIZE || length % OVERLAY_BLOCK_SIZE || offset < 0 || offset + length > this.byte_length)
    {
        return new DiskImageError(this.name + ": write of " + length + " bytes at " + offset + " is not in whole blocks of the disk", "io");
    }
    const first = offset / OVERLAY_BLOCK_SIZE, count = length / OVERLAY_BLOCK_SIZE;
    let added = 0;
    for(let i = 0; i < count; i++)
    {
        if(!this.blocks.has(first + i)) added++;
    }
    if((this.blocks.size + added) * OVERLAY_BLOCK_SIZE > this.limit)
    {
        return new DiskImageError(this.name + ": the guest's changes would exceed their memory budget (" +
            this.limit + " bytes): the write of " + length + " bytes at " + offset + " fails", "io");
    }
    // (the chunks the write needs first: a write that does not fit in
    // memory fails as a whole)
    const added_chunks = Math.ceil((this.blocks.size + added) / CHUNK_BLOCKS) - this.chunks.length;
    try
    {
        for(let i = 0; i < added_chunks; i++) this.spare_chunks.push(new Uint8Array(CHUNK_BLOCKS * OVERLAY_BLOCK_SIZE));
    }
    catch(e)
    {
        this.spare_chunks = [];
        return new DiskImageError(this.name + ": no memory for the guest's changes (" + this.size() +
            " bytes so far): the write of " + length + " bytes at " + offset + " fails (" + e.message + ")", "io");
    }
    for(let i = 0; i < count; i++)
    {
        this.write_block(first + i, data.subarray(i * OVERLAY_BLOCK_SIZE, (i + 1) * OVERLAY_BLOCK_SIZE));
    }
    this.spare_chunks = [];
    return undefined;
};

/**
 * @param {number} index
 * @param {!Uint8Array} data
 */
WriteOverlay.prototype.write_block = function(index, data)
{
    let slot = this.blocks.get(index);
    if(slot === undefined)
    {
        // (no block leaves the map: the next slot is its size)
        slot = this.blocks.size;
        if(slot % CHUNK_BLOCKS === 0)
        {
            this.chunks.push(this.spare_chunks.pop() || new Uint8Array(CHUNK_BLOCKS * OVERLAY_BLOCK_SIZE));
        }
        this.blocks.set(index, slot);
    }
    this.chunks[Math.floor(slot / CHUNK_BLOCKS)].set(data, slot % CHUNK_BLOCKS * OVERLAY_BLOCK_SIZE);
};

/**
 * Put the written blocks of [offset, offset + result.length) over the data
 * read from the image
 * @param {number} offset
 * @param {!Uint8Array} result
 */
WriteOverlay.prototype.apply = function(offset, result)
{
    if(this.blocks.size === 0) return;
    const first = Math.floor(offset / OVERLAY_BLOCK_SIZE);
    const last = Math.floor((offset + result.length - 1) / OVERLAY_BLOCK_SIZE);
    for(let index = first; index <= last; index++)
    {
        const block = this.block(index);
        if(!block) continue;
        const block_start = index * OVERLAY_BLOCK_SIZE;
        const from = Math.max(offset, block_start), to = Math.min(offset + result.length, block_start + OVERLAY_BLOCK_SIZE);
        result.set(block.subarray(from - block_start, to - block_start), from - offset);
    }
};

/**
 * Whether every block of [offset, offset + length) was written
 * @param {number} offset
 * @param {number} length
 * @return {boolean}
 */
WriteOverlay.prototype.covers = function(offset, length)
{
    if(this.blocks.size === 0 || length === 0) return false;
    const first = Math.floor(offset / OVERLAY_BLOCK_SIZE);
    const last = Math.floor((offset + length - 1) / OVERLAY_BLOCK_SIZE);
    for(let index = first; index <= last; index++)
    {
        if(!this.blocks.has(index)) return false;
    }
    return true;
};

/**
 * The written runs in disk order: [first block, slot, count], each run in
 * one chunk
 * @return {!Array<!Array<number>>}
 */
WriteOverlay.prototype.runs = function()
{
    const indices = Float64Array.from(this.blocks.keys()).sort();
    const runs = [];
    for(let i = 0; i < indices.length;)
    {
        const index = indices[i];
        const slot = this.blocks.get(index);
        let count = 1;
        while(i + count < indices.length && indices[i + count] === index + count &&
            this.blocks.get(index + count) === slot + count && (slot + count) % CHUNK_BLOCKS)
        {
            count++;
        }
        runs.push([index, slot, count]);
        i += count;
    }
    return runs;
};

/**
 * The data of `count` blocks from `slot` (a run)
 * @param {number} slot
 * @param {number} count
 * @return {!Uint8Array}
 */
WriteOverlay.prototype.slots = function(slot, count)
{
    const offset = slot % CHUNK_BLOCKS * OVERLAY_BLOCK_SIZE;
    return this.chunks[Math.floor(slot / CHUNK_BLOCKS)].subarray(offset, offset + count * OVERLAY_BLOCK_SIZE);
};

/**
 * The written blocks for a snapshot: their numbers in the order of their data
 * in the chunks, and the chunks (referenced, not copied: the machine is
 * stopped until it is saved), as AsyncXHRBuffer's
 * @return {!Array<*>}
 */
WriteOverlay.prototype.get_state = function()
{
    const count = this.blocks.size;
    const indices = new Float64Array(count);
    for(const [index, slot] of this.blocks)
    {
        indices[slot] = index;
    }
    return [indices, this.chunks.map((chunk, i) =>
        chunk.subarray(0, Math.min(CHUNK_BLOCKS, count - i * CHUNK_BLOCKS) * OVERLAY_BLOCK_SIZE))];
};

/**
 * Check a snapshot's written blocks against this disk
 * @param {*} indices
 * @param {*} chunks
 */
WriteOverlay.prototype.check_state = function(indices, chunks)
{
    const block_count = Math.ceil(this.byte_length / OVERLAY_BLOCK_SIZE);
    let total = 0;
    if(!Array.isArray(chunks)) throw new DiskImageError("Invalid disk snapshot: chunks", "config");
    for(const chunk of chunks)
    {
        if(!(chunk instanceof Uint8Array) || chunk.length % OVERLAY_BLOCK_SIZE)
        {
            throw new DiskImageError("Invalid disk snapshot: chunk", "config");
        }
        total += chunk.length / OVERLAY_BLOCK_SIZE;
    }
    if(!(indices instanceof Float64Array) || indices.length !== total ||
        indices.some(index => !Number.isInteger(index) || index < 0 || index >= block_count))
    {
        throw new DiskImageError("Invalid disk snapshot: block numbers", "config");
    }
    if(total * OVERLAY_BLOCK_SIZE > this.limit)
    {
        throw new DiskImageError(this.name + ": the snapshot's changes (" + total * OVERLAY_BLOCK_SIZE +
            " bytes) exceed the memory budget of this disk (" + this.limit + " bytes)", "config");
    }
};

/**
 * @param {!Float64Array} indices
 * @param {!Array<!Uint8Array>} chunks
 */
WriteOverlay.prototype.set_state = function(indices, chunks)
{
    this.check_state(indices, chunks);
    this.blocks.clear();
    this.chunks = [];
    let i = 0;
    for(const chunk of chunks)
    {
        const count = chunk.length / OVERLAY_BLOCK_SIZE;
        if(count === CHUNK_BLOCKS && i % CHUNK_BLOCKS === 0)
        {
            // a full chunk becomes this disk's as it is (a restore makes new
            // buffers for the snapshot's)
            this.chunks.push(chunk);
            for(const end = i + count; i < end; i++)
            {
                this.blocks.set(indices[i], i);
            }
            if(this.blocks.size !== i) throw new DiskImageError("Invalid disk snapshot: a block saved twice", "config");
        }
        else
        {
            for(let offset = 0; offset < chunk.length; offset += OVERLAY_BLOCK_SIZE)
            {
                this.write_block(indices[i++], chunk.subarray(offset, offset + OVERLAY_BLOCK_SIZE));
            }
        }
    }
};
