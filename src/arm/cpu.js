// The arm64 CPU of the virt machine (docs/arm64-virt-android16-plan.md P1.2):
// the JavaScript side of the ARM core (build/v86-arm64.wasm), with the
// interface src/main.js, src/browser/starter.js and src/state.js use of a CPU
// (init, run_cores, the clock, devices, snapshots, guest memory). Cores in
// vCPU workers (parallel) come with P8.2; until then the parallel members are
// empty. The x86 CPU is src/cpu.js.

import { dbg_assert } from "../log.js";
import { view, Bitmap } from "../lib.js";
import { v86 } from "../main.js";
import { MachineClock } from "../machine_clock.js";
import { check_machine_options } from "../machine_options.js";
import { CORE_STATE_RANGES, STATE_OFFSETS } from "./state_layout.js";
import { VirtIO } from "../virt/io.js";
import {
    A64_PROFILE, VIRT_LAYOUT_VERSION, VIRT_MMIO, VIRT_MMIO_COUNT, VIRT_MMIO_SIZE, VIRT_PCIE_MMIO, VIRT_PCIE_MMIO_HIGH,
    VIRT_PCIE_MMIO_HIGH_SIZE, VIRT_PCIE_MMIO_SIZE, VIRT_RAM_BASE, virt_machine,
} from "../virt/platform.js";
import { PL011 } from "../virt/pl011.js";
import { PL031 } from "../virt/pl031.js";
import { load_linux } from "../virt/loader.js";

/** (src/state.js: one buffer holds at most 2 GiB) */
const STATE_MAX_SINGLE_BUFFER = 0x7FFFFFFF;

/**
 * @constructor
 * @param {Object} bus
 * @param {Object} wm the ARM core: {exports, wasm_table}
 * @param {function()} stop_idling
 */
export function A64CPU(bus, wm, stop_idling)
{
    dbg_assert(wm.exports["isa_aarch64"], "A64CPU needs the ARM core (v86-arm64.wasm)");
    this.stop_idling = stop_idling;
    this.wm = wm;
    this.bus = bus;
    this.clock = new MachineClock({ now: v86.microtick });
    this.in_cpu = false;
    this.cpu_type = "arm64";
    this.machine_type = "virt";

    const memory = this.wm.exports.memory;
    this.wasm_memory = memory;
    const state_base = this.state_base = this.wm.exports["state_base"]() >>> 0;
    this.instruction_counter = view(Uint32Array, memory, state_base + STATE_OFFSETS.instruction_counter, 1);

    /** cores in vCPU workers: P8.2 */
    this.parallel = null;
    this.parallel_fallback = "";
    this.extended_pages = 0;
    this.extended_store = null;

    // (src/state.js reads memory_size[0])
    this.memory_size = new Uint32Array(1);
    this.mem8 = new Uint8Array(0);
    this.cores = 1;

    /** @type {!Object} */
    this.devices = {};
    /** the device registers (src/virt/io.js) */
    this.io = new VirtIO(this.wm.exports);
}

/** The shared imports the ARM core needs besides those of src/browser/starter.js */
A64CPU.prototype.imports = function()
{
    return {
        "a64_mmio_read": (owner, offset, width) => this.io.mmio_read(owner, offset, width),
        "a64_mmio_write": (owner, offset, width, value) => this.io.mmio_write(owner, offset, width, value),
    };
};

A64CPU.prototype.init = function(settings, device_bus)
{
    if(check_machine_options(settings).machine_type !== "virt")
    {
        throw new Error("The arm64 CPU runs machine_type \"virt\" only");
    }
    const { cores, memory_size } = virt_machine(settings);
    this.cores = cores;
    // (the GIC's distributor and redistributors: decoded in the core, P4.2)
    if(!this.wm.exports["a64_set_cores"](cores)) throw new Error("the GIC's frames overlap a device");
    if(settings.cpu_clock) this.clock = new MachineClock(Object.assign({ now: v86.microtick }, settings.cpu_clock));
    this.create_memory(memory_size);
    this.device_bus = device_bus;
    this.devices = {
        "pl011": new PL011(this, device_bus),
        "pl031": new PL031(this),
    };
    // (the PCIe host bridge comes with P5.10; until then its 32- and 64-bit
    // windows read as an empty bus does, all ones, as the reference's do)
    const empty_bus = {
        name: "pcie-window",
        read: (offset, width) => width === 8 ? 0xFFFFFFFFFFFFFFFFn : 2 ** (8 * width) - 1,
        write: () => {},
    };
    this.io.register_mmio(VIRT_PCIE_MMIO, VIRT_PCIE_MMIO_SIZE, empty_bus);
    this.io.register_mmio(VIRT_PCIE_MMIO_HIGH, VIRT_PCIE_MMIO_HIGH_SIZE, empty_bus);
    // (the virtio-mmio transports come with P5.1; until then each slot reads
    // as the reference's empty one: "virt", version 2, device ID 0, "QEMU")
    const empty_slot = {
        name: "virtio-mmio",
        read: offset => [0x74726976, 2, 0, 0x554D4551][offset >> 2] ?? 0,
        write: () => {},
    };
    /** @type {!Array<number>} the slots' owners (src/virt/io.js) */
    this.virtio_mmio_slots = [];
    for(let n = 0; n < VIRT_MMIO_COUNT; n++)
    {
        this.virtio_mmio_slots.push(this.io.register_mmio(VIRT_MMIO + n * VIRT_MMIO_SIZE, VIRT_MMIO_SIZE, empty_slot));
    }
    // the boot core starts at the kernel (P4.6: the device tree in x0, P4.2)
    this.booted = false;
    /** @type {Object} what the machine boots, loaded again at a reset */
    this.boot_files = null;
    if(settings.kernel)
    {
        // (kept: a reset loads them again, P4.6)
        this.boot_files = { kernel: settings.kernel, initrd: settings.initrd, cmdline: settings.cmdline, dtb: settings.dtb, cores };
        const { entry, x0 } = load_linux(this, this.boot_files);
        this.boot(entry, x0);
    }
};

/**
 * Reset the cores; core 0 starts at `entry` with x0 = `x0`
 * @param {number} entry
 * @param {number} x0
 */
A64CPU.prototype.boot = function(entry, x0)
{
    this.wm.exports["a64_boot"](entry >>> 0, Math.floor(entry / 0x100000000), x0 >>> 0, Math.floor(x0 / 0x100000000));
    this.boot_entry = entry;
    this.boot_x0 = x0;
    this.booted = true;
};

/**
 * Guest RAM of `size` bytes at 0x4000_0000
 * @param {number} size
 */
A64CPU.prototype.create_memory = function(size)
{
    const exports = this.wm.exports;
    const pointer = exports["a64_allocate_memory"](size) >>> 0;
    if(!exports["a64_bus_set_ram"](size)) throw new Error("create_memory: RAM of " + size + " bytes does not fit");
    this.mem8 = view(Uint8Array, this.wasm_memory, pointer, size);
    this.memory_size[0] = size;
};

/**
 * One turn of the machine: the cores' slices and the timers. Returns the
 * milliseconds until something is due (0: run again at once).
 * @return {number}
 */
A64CPU.prototype.run_cores = function()
{
    const run = this.wm.exports["a64_run_slice"];
    if(!run || !this.booted) return 100;
    this.in_cpu = true;
    try
    {
        const devices = this.run_hardware_timers(null, this.clock.now());
        return Math.min(run(this.clock.now()), devices);
    }
    finally
    {
        this.in_cpu = false;
    }
};

/** (env.run_hardware_timers) the virt machine's device timers (the PL031's alarm); the cores' timers are their own */
A64CPU.prototype.run_hardware_timers = function(acpi, now)
{
    return Math.min(100, this.devices["pl031"] ? this.devices["pl031"].timer() : 100);
};

/**
 * A device's interrupt line, an SPI of the GIC (P4.2)
 * @param {number} intid
 * @param {boolean} level
 */
A64CPU.prototype.set_irq = function(intid, level)
{
    this.wm.exports["a64_gic_set_spi"](intid, level);
};

/** Whether the guest turned the machine off (PSCI SYSTEM_OFF, P4.4) */
A64CPU.prototype.powered_off = function()
{
    return !!this.wm.exports["a64_powered_off"]?.();
};

/** Whether the device state may be saved now (no access of a core is in flight) */
A64CPU.prototype.snapshot_io_pending = function()
{
    return false;
};

/** @param {string=} reason */
A64CPU.prototype.reboot_internal = function(reason)
{
    if(!this.booted) return;
    for(const device of Object.values(this.devices)) device.reset?.();
    if(this.boot_files)
    {
        const { entry, x0 } = load_linux(this, this.boot_files);
        this.boot(entry, x0);
    }
    else
    {
        this.boot(this.boot_entry, this.boot_x0);
    }
};

// ---- guest memory (P1.6: the machine's DMA facade)

/** @return {boolean} whether [offset, offset + length) of guest memory is zero */
A64CPU.prototype.is_memory_zeroed = function(offset, length)
{
    dbg_assert((offset & 3) === 0 && (length & 3) === 0);
    const words = new Int32Array(this.mem8.buffer, this.mem8.byteOffset + offset, length >> 2);
    for(let i = 0; i < words.length; i++)
    {
        if(words[i] !== 0) return false;
    }
    return true;
};

A64CPU.prototype.zero_memory = function(offset, length)
{
    this.mem8.fill(0, offset, offset + length);
    this.wm.exports["a64_bus_written"](offset, length);
};

/**
 * The guest-memory offset of the physical range [address, address + length)
 * of RAM, or -1 when it is not all RAM
 * @param {number} address a physical address below 2^53
 * @param {number} length
 */
A64CPU.prototype.ram_offset = function(address, length)
{
    const offset = address - VIRT_RAM_BASE;
    return offset >= 0 && offset + length <= this.memory_size[0] ? offset : -1;
};

/** The end of the physical address space: profile v1's 40 bits */
A64CPU.prototype.physical_limit = 0x10000000000;

/**
 * Where a device's DMA to [address, address + length) goes (the machine's
 * DMA facade, P1.6): RAM is one contiguous backing
 * @param {number} address
 * @param {number} length
 * @return {number} the offset in guest memory, or -2 when it is not all RAM
 */
A64CPU.prototype.dma_classify = function(address, length)
{
    if(!Number.isSafeInteger(address) || !Number.isSafeInteger(length) || length <= 0) return -2;
    const offset = this.ram_offset(address, length);
    return offset < 0 ? -2 : offset;
};

/**
 * Read guest RAM at a physical address (V86.read_memory)
 * @param {number} address
 * @param {number} length
 * @return {!Uint8Array}
 */
A64CPU.prototype.read_blob_physical = function(address, length)
{
    const offset = this.ram_offset(address, length);
    if(offset < 0) throw new RangeError("read_blob_physical: [0x" + address.toString(16) + ", +" + length + ") is not RAM");
    return this.mem8.slice(offset, offset + length);
};

/**
 * Write guest RAM at a physical address (V86.write_memory, the loaders,
 * devices' DMA): code compiled from it retires
 * @param {!Uint8Array|!Array<number>} blob
 * @param {number} address
 */
A64CPU.prototype.write_blob_physical = function(blob, address)
{
    const offset = this.ram_offset(address, blob.length);
    if(offset < 0) throw new RangeError("write_blob_physical: [0x" + address.toString(16) + ", +" + blob.length + ") is not RAM");
    this.mem8.set(blob, offset);
    this.wm.exports["a64_bus_written"](offset, blob.length);
};

A64CPU.prototype.clear_extended_memory = function()
{
};

// ---- snapshots (P1.9): ["virt", VIRT_LAYOUT_VERSION, profile] in state[103]

/** The ARM core's state block of the current core, its per-core ranges */
A64CPU.prototype.save_core_state = function()
{
    const block = new Uint8Array(this.wasm_memory.buffer, this.state_base, 4096);
    const saved = new Uint8Array(CORE_STATE_RANGES.reduce((n, [a, b]) => n + b - a, 0));
    let at = 0;
    for(const [a, b] of CORE_STATE_RANGES)
    {
        saved.set(block.subarray(a, b), at);
        at += b - a;
    }
    return saved;
};

A64CPU.prototype.load_core_state = function(saved)
{
    const block = new Uint8Array(this.wasm_memory.buffer, this.state_base, 4096);
    let at = 0;
    for(const [a, b] of CORE_STATE_RANGES)
    {
        block.set(saved.subarray(at, at + b - a), a);
        at += b - a;
    }
};

A64CPU.prototype.get_state = function(skip_memory = false)
{
    const state = [];
    state[0] = this.memory_size[0];
    state[1] = this.cores;
    state[2] = [this.save_core_state()];
    if(skip_memory)
    {
        state[77] = null;
        state[78] = null;
    }
    else
    {
        const { packed_memory, bitmap } = this.pack_memory();
        state[77] = packed_memory;
        state[78] = new Uint8Array(bitmap.get_buffer());
    }
    state[99] = null;
    state[103] = ["virt", VIRT_LAYOUT_VERSION, A64_PROFILE];
    return state;
};

/** Refuse a snapshot of another machine (an x86 one in either direction) or layout */
A64CPU.prototype.validate_state = function(state)
{
    const identity = state[103];
    const machine = identity ? identity[0] : "i440fx";
    if(machine !== "virt")
    {
        throw new Error("The snapshot is from a machine with machine_type: \"" + machine + "\", this one has \"virt\"");
    }
    if(identity[1] !== VIRT_LAYOUT_VERSION || identity[2] !== A64_PROFILE)
    {
        throw new Error("The snapshot is from virt layout " + identity[1] + " with CPU profile " + identity[2] +
            "; this machine is layout " + VIRT_LAYOUT_VERSION + ", " + A64_PROFILE);
    }
    if(state[0] !== this.memory_size[0])
    {
        throw new Error("The snapshot has " + state[0] + " bytes of RAM, this machine " + this.memory_size[0]);
    }
    if(state[1] !== this.cores)
    {
        throw new Error("The snapshot has " + state[1] + " cores, this machine " + this.cores);
    }
};

A64CPU.prototype.set_state = function(state, skip_memory = false)
{
    this.validate_state(state);
    this.load_core_state(state[2][0]);
    if(!skip_memory && state[77])
    {
        this.unpack_memory(new Bitmap(state[78].buffer), state[77]);
    }
    // (cached translations and compiled code knew the old memory)
    this.wm.exports["jit_clear_cache_js"]?.();
};

A64CPU.prototype.pack_memory = function()
{
    const page_count = this.memory_size[0] >>> 12;
    const nonzero = [];
    for(let page = 0; page < page_count; page++)
    {
        if(!this.is_memory_zeroed(page << 12, 0x1000)) nonzero.push(page);
    }
    if(nonzero.length * 0x1000 > STATE_MAX_SINGLE_BUFFER)
    {
        throw new RangeError("The state is larger than a single-buffer snapshot can be (2 GiB): use save_state_stream");
    }
    const bitmap = new Bitmap(page_count);
    const packed_memory = new Uint8Array(nonzero.length * 0x1000);
    for(const [i, page] of nonzero.entries())
    {
        bitmap.set(page, 1);
        packed_memory.set(this.mem8.subarray(page << 12, (page << 12) + 0x1000), i << 12);
    }
    return { bitmap, packed_memory };
};

A64CPU.prototype.unpack_memory = function(bitmap, packed_memory)
{
    this.mem8.fill(0);
    const page_count = this.memory_size[0] >>> 12;
    let packed = 0;
    for(let page = 0; page < page_count; page++)
    {
        if(bitmap.get(page))
        {
            this.mem8.set(packed_memory.subarray(packed << 12, (packed << 12) + 0x1000), page << 12);
            packed++;
        }
    }
    this.wm.exports["a64_bus_written"](0, this.memory_size[0]);
};

// ---- zstd for snapshots (src/state.js), the shared module's exports

A64CPU.prototype.zstd_create_ctx = function(n) { return this.wm.exports["zstd_create_ctx"](n); };
A64CPU.prototype.zstd_get_src_ptr = function(ctx) { return this.wm.exports["zstd_get_src_ptr"](ctx); };
A64CPU.prototype.zstd_free_ctx = function(ctx) { return this.wm.exports["zstd_free_ctx"](ctx); };
A64CPU.prototype.zstd_read = function(ctx, length) { return this.wm.exports["zstd_read"](ctx, length); };
A64CPU.prototype.zstd_read_free = function(ptr, length) { return this.wm.exports["zstd_read_free"](ptr, length); };

A64CPU.prototype.get_diagnostics = function()
{
    return {
        "cpu_type": "arm64",
        "machine_type": "virt",
        "pc": this.read_pc(),
        "retired": this.wm.exports["core_statistics_get"] ? this.wm.exports["core_statistics_get"](0, 0) : 0,
        "undefined": this.undefined_instructions(),
    };
};

/**
 * UNDEF telemetry (P2.3): counts at EL0 and EL1, and the most recent ones
 * (PC, word, EL)
 */
A64CPU.prototype.undefined_instructions = function()
{
    const exports = this.wm.exports;
    if(!exports["a64_undef_count"]) return null;
    const last = [];
    for(let i = 0; i < 16; i++)
    {
        const word = exports["a64_undef_last"](i, 2) >>> 0;
        const pc = (exports["a64_undef_last"](i, 1) >>> 0) * 0x100000000 + (exports["a64_undef_last"](i, 0) >>> 0);
        if(!pc && !word) break;
        last.push({ "pc": "0x" + pc.toString(16), "word": "0x" + word.toString(16).padStart(8, "0"), "el": exports["a64_undef_last"](i, 3) });
    }
    return { "el0": exports["a64_undef_count"](0, 16), "el1": exports["a64_undef_count"](1, 16), "last": last };
};

/** The current core's PC, as a hexadecimal string */
A64CPU.prototype.read_pc = function()
{
    const words = view(Uint32Array, this.wasm_memory, this.state_base + STATE_OFFSETS.pc, 2);
    return "0x" + (words[1] * 0x100000000 + words[0]).toString(16);
};

A64CPU.prototype.get_jit_info = function()
{
    return { "enabled": false };
};
