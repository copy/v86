// The virt machine's device registers (docs/arm64-virt-android16-plan.md
// P1.7): the interface of src/io.js's memory-mapped ranges (register and
// unregister a range, handlers per access width), but with 64-bit addresses
// and exact ranges of any size. The ranges are regions of the ARM core's
// address space (src/rust/aarch64/bus.rs); an access reaches its handler with
// the offset in the range and its width (1, 2, 4 or 8 bytes). 64-bit
// addresses and values cross the boundary as [low, high] halves or BigInt.

/**
 * @typedef {{
 *     read: function(number, number): (number|bigint),
 *     write: function(number, number, (number|bigint)),
 *     name: (string|undefined),
 * }}
 * read(offset, width) returns the value (a BigInt or a number below 2^53);
 * write(offset, width, value) gets a BigInt for 8-byte writes, else a number
 */
export var MmioHandler;

/**
 * @constructor
 * @param {!Object} exports the ARM core's exports
 */
export function VirtDeviceSpace(exports)
{
    this.exports = exports;
    /** @type {!Array<{base: number, base_high: number, size: number, handler: MmioHandler}|null>} by owner */
    this.ranges = [null];
}

/**
 * Map [base, base + size) to `handler`
 * @param {number|Array<number>} base an address below 4 GiB or [low, high]
 * @param {number} size
 * @param {MmioHandler} handler
 * @return {number} the owner id
 */
VirtDeviceSpace.prototype.register_mmio = function(base, size, handler)
{
    const low = typeof base === "number" ? base >>> 0 : base[0];
    const high = typeof base === "number" ? Math.floor(base / 0x100000000) : base[1];
    const owner = this.ranges.length;
    if(!this.exports["a64_bus_map_mmio"](low, high, size >>> 0, Math.floor(size / 0x100000000), owner))
    {
        throw new Error("register_mmio: [0x" + (high * 0x100000000 + low).toString(16) + ", +0x" + size.toString(16) +
            ") overlaps RAM or another range, or lies beyond the 40-bit physical address space");
    }
    this.ranges.push({ base: low, base_high: high, size, handler });
    return owner;
};

/**
 * Unmap the range that `owner` names
 * @param {number} owner
 */
VirtDeviceSpace.prototype.unregister_mmio = function(owner)
{
    const range = this.ranges[owner];
    if(!range) throw new Error("unregister_mmio: no range " + owner);
    this.exports["a64_bus_unmap"](range.base, range.base_high);
    this.ranges[owner] = null;
};

/** (env.a64_mmio_read) */
VirtDeviceSpace.prototype.mmio_read = function(owner, offset, width)
{
    const range = this.ranges[owner];
    const value = range ? range.handler.read(Number(offset), width) : 0;
    return BigInt.asUintN(width * 8, typeof value === "bigint" ? value : BigInt(Math.trunc(value)));
};

/** (env.a64_mmio_write) */
VirtDeviceSpace.prototype.mmio_write = function(owner, offset, width, value)
{
    const range = this.ranges[owner];
    if(!range) return;
    value = BigInt.asUintN(64, value);
    range.handler.write(Number(offset), width, width === 8 ? value : Number(value));
};
