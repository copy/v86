// A partition of a disk as a disk of its own (the ranchu machine's virtio
// disks on an emulator image's GPT disk, docs/android-images-plan.md I6):
// the disk buffer's reads, writes and flushes moved by the partition's
// start, its size the partition's. A snapshot keeps the disk's state once,
// with the partition that owns it (the first written one); the others keep
// none.

import { check_disk_state, restore_disk_state } from "../disk_writeback.js";

/**
 * @constructor
 * @param {?} disk the disk's buffer (src/buffer.js, a write-back backend)
 * @param {{name: string, start: number, size: number}} partition
 * @param {boolean} owner whether this partition's snapshot state is the disk's
 */
export function PartitionBuffer(disk, partition, owner)
{
    this.disk = disk;
    this.start = partition.start;
    this.byteLength = partition.size;
    this.owner = owner;
    this.disk_name = (disk.disk_name ? disk.disk_name + ":" : "") + partition.name;
    this.disk_error = disk.disk_error;
    this.logical_sector_size = disk.logical_sector_size;
}

PartitionBuffer.prototype.get = function(start, length, callback)
{
    this.disk.get(this.start + start, length, callback);
};

PartitionBuffer.prototype.set = function(start, data, callback)
{
    this.disk.set(this.start + start, data, callback);
};

PartitionBuffer.prototype.flush = function(callback)
{
    if(this.disk.flush) return this.disk.flush(callback);
    callback && callback();
};

PartitionBuffer.prototype.get_state = function()
{
    return this.owner ? [this.disk] : [];
};

PartitionBuffer.prototype.check_state = function(state)
{
    if(this.owner && state[0] !== undefined) check_disk_state(this.disk_name, this.disk, state[0]);
};

PartitionBuffer.prototype.set_state = function(state)
{
    if(this.owner && state[0] !== undefined) restore_disk_state(this.disk, state[0]);
};
