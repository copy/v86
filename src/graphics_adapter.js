// Display adapters (the graphics_adapter option) are plugins: each lives in its
// own file and is loaded only when it is configured. v86 owns the VGA slot,
// the PCI bus, the port and memory maps, device memory (mmio_ram), the display
// hub and the adapter's place in a snapshot; the plugin owns the device.
// Plugins are not compiled with v86 (v86_all.js renames properties), so the
// handle a plugin gets and the descriptor and device it gives back use quoted
// names only. src/graphics_adapters/machine.js is the plugin's end of it.
// See docs/gpu-devices.md, "Adapter plugins".

import { LOG_PCI, FLAG_VM } from "./const.js";
import { dbg_log } from "./log.js";
import { pci_functions } from "./platform.js";
import { DisplaySource } from "./display.js";
import { create_adapter_virtio_device } from "./virtio_devices.js";

// For Types Only
import { CPU } from "./cpu.js";

/* global __dirname, V86_BUNDLE, V86_BUNDLE_URL */

/** Every value graphics_adapter may name */
const ADAPTERS = ["bochs_vga", "vmware_svga", "virtio_gpu", "none"];

/**
 * The largest vram_size: the VGA core backs at most this much
 * (VGA_MAX_MEMORY_SIZE in graphics_adapters/vga_core.js), and a device whose
 * BAR were larger would reach past it
 */
export const MAX_VRAM_SIZE = 256 << 20;

/** The global registry plugin files add their descriptors to */
const REGISTRY = "V86GraphicsAdapters";

/** Where allocate_io looks for ports (below the virtio_devices pool at 0xE000) */
const IO_POOL_START = 0xD000;
const IO_POOL_END = 0xE000;

/** state[52] is [STATE_TAG, STATE_VERSION, adapter name, device state] */
const STATE_TAG = "graphics_adapter";
const STATE_VERSION = 1;

const NODE = typeof process !== "undefined" && process.versions && process.versions.node;

/**
 * The bundle's own URL: plugins are built beside it. libv86.mjs gets it from
 * its output wrapper (import.meta.url); a classic script in a page (libv86.js,
 * v86_all.js) from document.currentScript while it runs
 */
const BUNDLE_URL = typeof V86_BUNDLE_URL === "string" ? V86_BUNDLE_URL :
    typeof document !== "undefined" && document.currentScript && document.currentScript.src || "";

/**
 * Check the display options of new V86(): graphics_adapter is required
 * @param {!Object} options
 * @return {string} the adapter's name
 */
export function check_graphics_adapter_options(options)
{
    const adapter = options["graphics_adapter"];
    const supported = ADAPTERS.map(name => "\"" + name + "\"").join(", ");

    if(typeof adapter === "function")
    {
        throw new Error("graphics_adapter now selects the display hardware; use graphics_proxy: true instead of installV86GLGraphicsAdapter");
    }
    if(adapter === undefined)
    {
        throw new Error("graphics_adapter is required; supported: " + supported +
            " (\"bochs_vga\" is the display v86 always had)");
    }
    if(typeof adapter !== "string" || !ADAPTERS.includes(adapter))
    {
        throw new Error("Unknown graphics_adapter " + JSON.stringify(adapter) + "; supported: " + supported);
    }

    if(options["vga_memory_size"] !== undefined)
    {
        throw new Error("vga_memory_size was renamed to vram_size");
    }
    const vram_size = options["vram_size"];
    if(vram_size !== undefined && !(Number.isSafeInteger(vram_size) && vram_size > 0 && (vram_size & (vram_size - 1)) === 0))
    {
        throw new Error("vram_size must be a power of two (in bytes)");
    }
    if(vram_size > MAX_VRAM_SIZE)
    {
        throw new Error("vram_size must be at most " + (MAX_VRAM_SIZE >> 20) + " MiB");
    }
    if(adapter === "none" && vram_size !== undefined)
    {
        console.warn("vram_size is ignored: graphics_adapter is \"none\"");
    }

    const path = options["graphics_adapter_path"];
    if(path !== undefined && (typeof path !== "string" || !path))
    {
        throw new Error("graphics_adapter_path must be the path or URL of the plugin file");
    }

    return adapter;
}

/**
 * Where a bundle looks for a plugin without graphics_adapter_path: beside
 * the bundle where it knows its own location (a classic script in a page,
 * CommonJS in node), otherwise build/ relative to the page, like wasm_path
 * @param {string} name
 * @return {string}
 */
export function default_graphics_adapter_path(name)
{
    const file = "v86-" + name.replace(/_/g, "-") + ".js";
    if(BUNDLE_URL) return new URL(file, BUNDLE_URL).href;
    if(NODE && typeof __dirname === "string") return __dirname + "/" + file;
    return "build/" + file;
}

/**
 * An absolute URL of a plugin file
 * @param {string} path
 * @return {string}
 */
export function resolve_graphics_adapter_path(path)
{
    if(NODE)
    {
        if(/^[a-z]+:/i.test(path)) return path;
        const absolute = path.startsWith("/") ? path : process["cwd"]() + "/" + path;
        return "file://" + absolute;
    }
    return new URL(path, typeof location !== "undefined" ? location.href : undefined).href;
}

/**
 * @param {string} name
 * @return {Object|undefined}
 */
function registered(name)
{
    const registry = globalThis[REGISTRY];
    return registry ? registry[name] : undefined;
}

/**
 * Load a display adapter plugin, unless the page already did
 * @param {string} name
 * @param {string|undefined} path graphics_adapter_path
 * @return {!Promise<!Object>} its descriptor
 */
export async function load_graphics_adapter(name, path)
{
    let descriptor = registered(name);

    if(!descriptor)
    {
        if(typeof V86_BUNDLE === "undefined" && path === undefined)
        {
            // From the source tree: the plugin's entry module
            await import("./graphics_adapters/" + name + "/plugin.js");
        }
        else
        {
            const url = resolve_graphics_adapter_path(path || default_graphics_adapter_path(name));
            try
            {
                if(typeof importScripts === "function")
                {
                    // a classic worker (the CPU worker)
                    importScripts(url);
                }
                else
                {
                    await import(url);
                }
            }
            catch(error)
            {
                throw new Error("graphics_adapter \"" + name + "\": cannot load " + url +
                    " (" + (error && error.message || error) + "); set graphics_adapter_path to the plugin file");
            }
        }

        descriptor = registered(name);
        if(!descriptor)
        {
            throw new Error("graphics_adapter \"" + name + "\": the plugin file defines no such adapter");
        }
    }

    if(descriptor["name"] !== name || typeof descriptor["create"] !== "function" ||
        !Number.isInteger(descriptor["pci_vendor"]) || !Number.isInteger(descriptor["pci_device"]))
    {
        throw new Error("graphics_adapter \"" + name + "\": invalid plugin descriptor");
    }
    return descriptor;
}

/**
 * Make the PCI ROM header of a SeaBIOS-built VGA BIOS name the adapter's
 * device: SeaBIOS only runs a PCI ROM whose vendor and device match
 * (src/optionroms.c, map_pcirom). The code reads the real IDs from the
 * device itself, so SeaVGABIOS's per-device builds differ only in this
 * header. Its checksum byte is byte 6 (scripts/buildrom.py).
 * @param {!Uint8Array} rom
 * @param {number} vendor
 * @param {number} device
 */
export function patch_vga_bios_ids(rom, vendor, device)
{
    if(rom.length < 0x1C || rom[0] !== 0x55 || rom[1] !== 0xAA) return;
    const pcir = rom[0x18] | rom[0x19] << 8;
    if(pcir + 8 > rom.length ||
        rom[pcir] !== 0x50 || rom[pcir + 1] !== 0x43 || rom[pcir + 2] !== 0x49 || rom[pcir + 3] !== 0x52)
    {
        return;
    }
    if((rom[pcir + 4] | rom[pcir + 5] << 8) === vendor && (rom[pcir + 6] | rom[pcir + 7] << 8) === device)
    {
        return;
    }
    const seabios = new TextDecoder("latin1").decode(rom).includes("SeaBIOS");
    if(!seabios)
    {
        console.warn("The VGA BIOS is not a SeaBIOS build and does not name the display adapter's PCI device; SeaBIOS may not run it");
        return;
    }

    const size = Math.min(rom[2] * 512, rom.length);
    rom[pcir + 4] = vendor & 0xFF;
    rom[pcir + 5] = vendor >> 8;
    rom[pcir + 6] = device & 0xFF;
    rom[pcir + 7] = device >> 8;
    rom[6] = 0;
    let sum = 0;
    for(let i = 0; i < size; i++) sum += rom[i];
    rom[6] = -sum & 0xFF;
    dbg_log("VGA BIOS patched for PCI device " + vendor.toString(16) + ":" + device.toString(16), LOG_PCI);
}

/**
 * A plugin's scanout, as the display hub sees it
 * @constructor
 * @implements {DisplaySource}
 * @param {!Object} source quoted { vblank_period, on_vblank, render, invalidate }
 */
function PluginDisplaySource(source)
{
    this.source = source;
}

PluginDisplaySource.prototype.vblank_period = function()
{
    return this.source["vblank_period"]();
};

PluginDisplaySource.prototype.on_vblank = function()
{
    this.source["on_vblank"]();
};

PluginDisplaySource.prototype.render = function()
{
    this.source["render"]();
};

PluginDisplaySource.prototype.invalidate = function()
{
    this.source["invalidate"]();
};

/**
 * The configured display adapter: v86's side of a plugin's device
 * @constructor
 * @param {CPU} cpu
 * @param {!Object} descriptor from load_graphics_adapter
 * @param {!Object} options { vram_size, test, renderer }
 */
export function GraphicsAdapter(cpu, descriptor, options)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    this.descriptor = descriptor;

    /** @const @type {string} */
    this.name = descriptor["name"];

    /** The VGA slot: other devices keep their addresses whichever adapter is used */
    this.pci_id = pci_functions(cpu.platform).vga;

    this.pci_device = null;

    this.device = descriptor["create"](this.create_handle(), {
        "vram_size": options.vram_size,
        // graphics_adapter_test: internal, for tests that pin what the
        // adapter declares (its level); not part of the public options
        "test": options.test,
        // the channel to the adapter's 3D renderer, if the page made one
        "renderer": options.renderer || null,
    });
    if(!this.device || typeof this.device["get_state"] !== "function" || typeof this.device["set_state"] !== "function")
    {
        throw new Error("graphics_adapter \"" + this.name + "\": the plugin made no device");
    }
}

/**
 * For the VMware backdoor: a VMware SVGA device's capabilities and 3D
 * hardware version, or null for the other adapters
 * @return {?{capabilities: number, hardware_version: number}}
 */
GraphicsAdapter.prototype.svga_capabilities = function()
{
    const get = this.device["svga_capabilities"];
    const result = get ? get() : null;
    return result ? { capabilities: result["capabilities"] >>> 0, hardware_version: result["hardware_version"] >>> 0 } : null;
};

/**
 * Whether the device keeps state outside of the machine (a GPU) that a
 * snapshot has to fetch first, with prepare_save
 * @return {boolean}
 */
GraphicsAdapter.prototype.has_host_state = function()
{
    return !!this.device["has_host_state"] && this.device["has_host_state"]();
};

/**
 * @return {!Promise<undefined>}
 */
GraphicsAdapter.prototype.prepare_save = function()
{
    return this.has_host_state() ? this.device["prepare_save"]() : Promise.resolve(undefined);
};

/**
 * What the plugin gets to work with (src/graphics_adapters/machine.js)
 */
GraphicsAdapter.prototype.create_handle = function()
{
    const cpu = this.cpu;
    const io = cpu.io;
    const hub = cpu.devices.display;
    // Port and memory map entries are owned by this object; the plugin's
    // handlers come bound to its own device
    const owner = this;

    return {
        "name": this.name,
        "wasm_memory": cpu.wasm_memory,
        "qemu_compatible": !!cpu.platform.qemu_compatible,

        "register_read": (port, r8, r16, r32) => io.register_read(port, owner, r8, r16, r32),
        "register_write": (port, w8, w16, w32) => io.register_write(port, owner, w8, w16, w32),
        "register_write_consecutive": (port, w8_1, w8_2, w8_3, w8_4) =>
        {
            if(w8_3) io.register_write_consecutive(port, owner, w8_1, w8_2, w8_3, w8_4);
            else io.register_write_consecutive(port, owner, w8_1, w8_2);
        },
        "mmap_register": (address, size, r8, w8, r32, w32) => io.mmap_register(address, size, r8, w8, r32, w32),
        // an exact range inside a 128 KiB block (docs/arm64-virt-android16-plan.md P1.7)
        "mmap_register_range": (address, size, r8, w8, r32, w32) => io.mmap_register_range(address, size, owner, r8, w8, r32, w32),
        "mmap_unregister_range": (address, size) => io.mmap_unregister_range(address, size, owner),
        "allocate_io": size => this.allocate_io(size),

        "mmio_ram_allocate": size => cpu.mmio_ram_allocate(size),
        "mmio_ram_backing": region => cpu.mmio_ram_backing(region),
        "mmio_ram_map": (region, address) => cpu.mmio_ram_map(region, address),
        "mmio_ram_read8": (region, offset) => cpu.mmio_ram_read8(region, offset),
        "mmio_ram_write8": (region, offset, value) => cpu.mmio_ram_write8(region, offset, value),
        "mmio_ram_mark_dirty": region => cpu.mmio_ram_mark_dirty(region),
        "mmio_ram_take_dirty": region => cpu.mmio_ram_take_dirty(region),
        "mmio_ram_unmap": region => cpu.mmio_ram_unmap(region),
        "mmio_ram_allocate_pixels": (region, pixels) => cpu.mmio_ram_allocate_pixels(region, pixels),
        "mmio_ram_fill_pixels": (region, bpp, offset) => cpu.mmio_ram_fill_pixels(region, bpp, offset),
        "dirty_min_offset": () => cpu.svga_dirty_bitmap_min_offset[0],
        "dirty_max_offset": () => cpu.svga_dirty_bitmap_max_offset[0],

        "register_pci": description => this.register_pci(description),
        // virtio-vga: the adapter's PCI function is a virtio device (the
        // descriptor as for virtio_devices, see create_adapter_virtio_device)
        "create_virtio": descriptor => this.create_virtio(descriptor),
        "raise_irq": () => cpu.devices.pci.raise_irq(this.pci_id),
        "lower_irq": () => cpu.devices.pci.lower_irq(this.pci_id),

        "read_physical": (address, length) => cpu.read_blob_physical(address, length),
        "write_physical": (bytes, address) => cpu.write_blob_physical(bytes, address),
        // (virtqueues: virtio_gpu's rings in guest memory)
        "read16_physical": address => cpu.read16_physical(address),
        "read32_physical": address => cpu.read32_physical(address),
        "write16_physical": (address, value) => cpu.write16_physical(address, value),
        "write32_physical": (address, value) => cpu.write32_physical(address, value),
        "validate_physical_range": (address, length) => cpu.validate_physical_range(address, length),

        "now": () => cpu.clock.now(),
        // The size the page would like the guest's display to have
        // (V86.set_display_size): width, height, the display's index
        "on_host_display_size": handler =>
            cpu.bus.register("display-host-size", data => handler(data[0], data[1], data[2] || 0), this),
        "in_vm86": () => !!(cpu.flags[0] & FLAG_VM),

        "display": {
            "set_mode": graphical => hub.set_mode(graphical),
            "set_size_text": (cols, rows) => hub.set_size_text(cols, rows),
            "set_size_graphical": (width, height, buffer_width, buffer_height, bpp) =>
                hub.set_size_graphical(width, height, buffer_width, buffer_height, bpp),
            "put_char": (row, col, chr, flags, bg_color, fg_color) =>
                hub.put_char(row, col, chr, flags, bg_color, fg_color),
            "update_cursor": (row, col) => hub.update_cursor(row, col),
            "update_cursor_scanline": (start, end, enabled) => hub.update_cursor_scanline(start, end, enabled),
            "set_font_bitmap": (height, width_9px, width_dbl, copy_8th_col, bitmap, bitmap_changed) =>
                hub.set_font_bitmap(height, width_9px, width_dbl, copy_8th_col, bitmap, bitmap_changed),
            "set_font_page": (page_a, page_b) => hub.set_font_page(page_a, page_b),
            "clear_screen": () => hub.clear_screen(),
            "clear_text_state": () => hub.clear_text_state(),
            "update_buffer": layers => hub.update_buffer(layers.map(layer => ({
                pixels: {
                    data: layer["pixels"]["data"],
                    width: layer["pixels"]["width"],
                    height: layer["pixels"]["height"],
                },
                screen_x: layer["screen_x"],
                screen_y: layer["screen_y"],
                buffer_x: layer["buffer_x"],
                buffer_y: layer["buffer_y"],
                buffer_width: layer["buffer_width"],
                buffer_height: layer["buffer_height"],
            }))),
            "time_since_vblank": now => hub.time_since_vblank(now),
            "add_source": source => hub.add_source(new PluginDisplaySource(source)),
            "add_timer": timer => hub.add_timer(timer),
        },
    };
};

/**
 * A free window of I/O ports for an I/O BAR, aligned to its size: the same
 * one for the same machine configuration, so that snapshots line up. The
 * guest's firmware usually moves it anyway (PCI.set_io_bars).
 * @param {number} size a power of two
 * @return {number}
 */
GraphicsAdapter.prototype.allocate_io = function(size)
{
    const ports = this.cpu.io.ports;
    for(let base = IO_POOL_START; base + size <= IO_POOL_END; base += size)
    {
        let free = true;
        for(let port = base; port < base + size && free; port++)
        {
            free = !ports[port].device;
        }
        if(free) return base;
    }
    throw new Error("graphics_adapter \"" + this.name + "\": no free I/O ports");
};

/**
 * @param {!Object} description quoted { pci_space, pci_bars, pci_rom_size, pci_rom_address }
 */
GraphicsAdapter.prototype.register_pci = function(description)
{
    if(this.pci_device)
    {
        throw new Error("graphics_adapter \"" + this.name + "\" registered its PCI function twice");
    }
    this.pci_device = {
        name: this.name,
        pci_id: this.pci_id,
        pci_space: description["pci_space"],
        pci_bars: description["pci_bars"].map(bar => bar && {
            size: bar["size"],
            on_move: bar["on_move"],
        }),
        pci_rom_size: description["pci_rom_size"],
        pci_rom_address: description["pci_rom_address"],
    };
    this.cpu.devices.pci.register_device(this.pci_device);
};

/**
 * @param {*} descriptor
 * @return {!Object} the device's quoted handle
 */
GraphicsAdapter.prototype.create_virtio = function(descriptor)
{
    if(this.pci_device)
    {
        throw new Error("graphics_adapter \"" + this.name + "\" registered its PCI function twice");
    }
    const device = create_adapter_virtio_device(this.cpu, descriptor, this.pci_id);
    this.pci_device = device.virtio;
    return device.handle;
};

/**
 * The plugin's own object for tests and debugging (cpu.devices.vga): the
 * VGA core of every adapter that has one
 */
GraphicsAdapter.prototype.vga = function()
{
    return this.device["vga"];
};

/**
 * A machine reset (PCIRST#): the plugin's optional reset hook
 */
GraphicsAdapter.prototype.reset = function()
{
    const reset = this.device["reset"];
    if(typeof reset === "function") reset();
};

GraphicsAdapter.prototype.get_state = function()
{
    return [STATE_TAG, STATE_VERSION, this.name, this.device["get_state"]()];
};

/**
 * Throws if a snapshot's state[52] does not belong to this adapter. Changes
 * nothing, so that CPU.validate_state can call it before restoring anything.
 * @param {*} state
 */
GraphicsAdapter.prototype.check_state = function(state)
{
    const saved = graphics_adapter_of_state(state);
    if(saved !== this.name)
    {
        throw new Error("The snapshot is from a machine with graphics_adapter: " +
            JSON.stringify(saved) + ", this one has \"" + this.name + "\"");
    }
    if(state[0] === STATE_TAG && state[1] !== STATE_VERSION)
    {
        throw new Error("Unsupported graphics adapter state version " + state[1]);
    }
};

/** @param {*} state */
GraphicsAdapter.prototype.set_state = function(state)
{
    this.check_state(state);
    // Before plugins, state[52] was the Bochs VGA's own state
    this.device["set_state"](state[0] === STATE_TAG ? state[3] : state);
};

/**
 * Which adapter a snapshot's state[52] belongs to
 * @param {*} state
 * @return {string}
 */
export function graphics_adapter_of_state(state)
{
    if(state === undefined || state === null) return "none";
    if(Array.isArray(state) && state[0] === STATE_TAG) return state[2];
    // Older snapshots: the Bochs VGA, the only display v86 had
    return "bochs_vga";
}
