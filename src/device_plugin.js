// Device plugins: display adapters (src/graphics_adapter.js), network cards
// (net_device.type "e1000") and sound cards (audio_device "hd_audio") each
// live in their own file and are loaded only when configured. This is v86's
// side of what they share: finding and loading a plugin file, the machine
// handle a plugin works with, the machine's timers, and the plugin's slot in a
// snapshot. Plugins are not compiled with v86 (an ADVANCED build renames
// properties), so the handle, the descriptor and the device use quoted names
// only. src/device_machine.js is the plugin's end of it.
// See docs/gpu-devices.md, "Adapter plugins", and
// docs/modern-pc-devices-plan.md, "设备插件".

import { LOG_PCI } from "./const.js";
import { BlockBackend, block_drop_holds } from "./block_backend.js";
import { dbg_log } from "./log.js";
import { msi_capability } from "./pci.js";

// For Types Only
import { CPU } from "./cpu.js";

/* global __dirname, V86_BUNDLE, V86_BUNDLE_URL */

const NODE = typeof process !== "undefined" && process.versions && process.versions.node;

/**
 * The bundle's own URL: plugins are built beside it. libv86.mjs gets it from
 * its output wrapper (import.meta.url); a classic script in a page (libv86.js)
 * from document.currentScript while it runs
 */
const BUNDLE_URL = typeof V86_BUNDLE_URL === "string" ? V86_BUNDLE_URL :
    typeof document !== "undefined" && document.currentScript && document.currentScript.src || "";

/** Where allocate_io looks for ports (below the virtio_devices pool at 0xE000) */
const IO_POOL_START = 0xD000;
const IO_POOL_END = 0xE000;

/**
 * The kinds of plugin: the global registry plugin files add their
 * descriptors to, the option that names them (for messages), the directory
 * of their entry modules in the source tree (or the entry module itself:
 * one plugin of the kind), and their snapshot slot's tag
 * @typedef {{registry: string, option: string, dir: string, tag: string, entry: (string|undefined)}}
 */
export let PluginKind;

/** @const @type {PluginKind} */
export const GRAPHICS_PLUGINS = { registry: "V86GraphicsAdapters", option: "graphics_adapter", dir: "graphics_adapters", tag: "graphics_adapter" };
/** @const @type {PluginKind} */
export const NET_PLUGINS = { registry: "V86NetAdapters", option: "net_device", dir: "net_adapters", tag: "net_adapter" };
/** @const @type {PluginKind} */
export const AUDIO_PLUGINS = { registry: "V86AudioDevices", option: "audio_device", dir: "audio_devices", tag: "audio_device" };
/** @const @type {PluginKind} the USB controllers and devices: one plugin, "usb" */
export const USB_PLUGINS = { registry: "V86UsbControllers", option: "usb", dir: "usb", tag: "usb", entry: "./usb/plugin.js" };

/** A plugin slot's snapshot entry: [tag, STATE_VERSION, name, device state] */
const STATE_VERSION = 1;

/**
 * The file of a plugin: v86-<name>.js, underscores as dashes
 * @param {string} name
 * @return {string}
 */
export function plugin_file(name)
{
    return "v86-" + name.replace(/_/g, "-") + ".js";
}

/**
 * Where a bundle looks for a plugin without a path option: beside the bundle
 * where it knows its own location (a classic script in a page, CommonJS in
 * node), otherwise build/ relative to the page, like wasm_path
 * @param {string} name
 * @return {string}
 */
export function default_plugin_path(name)
{
    const file = plugin_file(name);
    if(BUNDLE_URL) return new URL(file, BUNDLE_URL).href;
    if(NODE && typeof __dirname === "string") return __dirname + "/" + file;
    return "build/" + file;
}

/**
 * An absolute URL of a plugin file
 * @param {string} path
 * @return {string}
 */
export function resolve_plugin_path(path)
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
 * @param {PluginKind} kind
 * @param {string} name
 * @return {Object|undefined}
 */
function registered(kind, name)
{
    const registry = globalThis[kind.registry];
    return registry ? registry[name] : undefined;
}

/**
 * Load a plugin, unless the page already did
 * @param {PluginKind} kind
 * @param {string} name
 * @param {string|undefined} path the kind's path option
 * @param {string} path_option its name, for messages
 * @return {!Promise<!Object>} its descriptor (checked: a "name" and a "create")
 */
export async function load_device_plugin(kind, name, path, path_option)
{
    const label = kind.option + " \"" + name + "\"";
    let descriptor = registered(kind, name);

    if(!descriptor)
    {
        if(typeof V86_BUNDLE === "undefined" && path === undefined)
        {
            // From the source tree: the plugin's entry module
            await import(kind.entry || "./" + kind.dir + "/" + name + "/plugin.js");
        }
        else
        {
            const url = resolve_plugin_path(path || default_plugin_path(name));
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
                throw new Error(label + ": cannot load " + url +
                    " (" + (error && error.message || error) + "); set " + path_option + " to the plugin file");
            }
        }

        descriptor = registered(kind, name);
        if(!descriptor)
        {
            throw new Error(label + ": the plugin file defines no such device");
        }
    }

    if(descriptor["name"] !== name || typeof descriptor["create"] !== "function")
    {
        throw new Error(label + ": invalid plugin descriptor");
    }
    return descriptor;
}

/**
 * A free window of I/O ports for an I/O BAR, aligned to its size: the same
 * one for the same machine configuration, so that snapshots line up. The
 * guest's firmware usually moves it anyway (PCI.set_io_bars).
 * @param {CPU} cpu
 * @param {number} size a power of two
 * @param {string} label for the message
 * @return {number}
 */
export function allocate_io_ports(cpu, size, label)
{
    const ports = cpu.io.ports;
    for(let base = IO_POOL_START; base + size <= IO_POOL_END; base += size)
    {
        let free = true;
        for(let port = base; port < base + size && free; port++)
        {
            free = !ports[port].device;
        }
        if(free) return base;
    }
    throw new Error(label + ": no free I/O ports");
}

/**
 * What every plugin works with (src/device_machine.js): ports and memory
 * maps, guest memory, the machine clock and timers, IRQs and the PCI
 * function. `owner` owns the port and memory map entries (the plugin's
 * handlers come bound to its own device) and has `name`, `pci_id` and
 * `register_pci(description)`.
 * @param {CPU} cpu
 * @param {!Object} owner
 * @return {!Object}
 */
export function device_handle(cpu, owner)
{
    const io = cpu.io;
    const pci = () => cpu.devices.pci;
    return {
        "name": owner.name,
        "wasm_memory": cpu.wasm_memory,
        "qemu_compatible": !!(cpu.platform && cpu.platform.qemu_compatible),
        "machine_type": cpu.platform ? cpu.platform.machine : "i440fx",

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
        "allocate_io": size => owner.allocate_io ? owner.allocate_io(size) : allocate_io_ports(cpu, size, owner.name),

        "register_pci": description => owner.register_pci(description),
        "pci_id": () => owner.pci_id,
        "raise_irq": () => pci().raise_irq(owner.pci_id),
        "lower_irq": () => pci().lower_irq(owner.pci_id),
        // whether the function decodes memory at [base, base + size): its memory
        // space is enabled and the bridges upstream forward the range
        "memory_decoded": (base, size) => pci().memory_decoded(owner.pci_id, base, size),
        // whether it may master the bus (DMA, MSI)
        "is_bus_master": () => pci().is_bus_master(owner.pci_id),
        // single-vector MSI: the capability's bytes (src/pci.js), and the
        // calls with its offset in the configuration space
        "msi_capability": next => msi_capability(next),
        "msi_config_written": (cap, next) => pci().msi_config_written(owner.pci_id, cap, next || 0),
        "msi_enabled": cap => pci().msi_enabled(owner.pci_id, cap),
        "msi_notify": cap => pci().msi_notify(owner.pci_id, cap),
        // the function's configuration space as bytes (a view taken now): a
        // device keeps its capabilities' read-only bytes after a write
        "pci_config": () => pci().space_bytes(owner.pci_id),

        "read_physical": (address, length) => cpu.read_blob_physical(address, length),
        "write_physical": (bytes, address) => cpu.write_blob_physical(bytes, address),
        "read16_physical": address => cpu.read16_physical(address),
        "read32_physical": address => cpu.read32_physical(address),
        "write16_physical": (address, value) => cpu.write16_physical(address, value),
        "write32_physical": (address, value) => cpu.write32_physical(address, value),
        "validate_physical_range": (address, length) => cpu.validate_physical_range(address, length),

        "now": () => cpu.clock.now(),
        // run whenever the machine's timers run (each slice of the CPU's);
        // returns milliseconds until it needs to run again
        "add_timer": timer => /** @type {?} */ (cpu).add_device_timer(timer),
        // an event from the host (a frame from the network) set a deadline:
        // a halted machine runs its timers again now rather than when it
        // planned to wake
        "wake": () => cpu.stop_idling(),
        // a disk image the host gave the plugin (a USB disk's): block_handle
        "block_backend": buffer => block_handle(/** @type {!CPU} */ (cpu), buffer),
    };
}

/**
 * A disk image for a plugin's device: the core's block backend
 * (src/block_backend.js) on the image's buffer, by quoted names: reads a
 * reset cancels, "flush" after the writes before it, I/O a snapshot waits
 * for, the disk's error policy; "drop" when the device is gone (its requests
 * held after an error are dropped)
 * @param {!CPU} cpu
 * @param {!Object} buffer
 * @return {!Object}
 */
export function block_handle(cpu, buffer)
{
    const backend = new BlockBackend(cpu, buffer);
    return {
        "byte_length": backend.byte_length,
        "read": (start, length, callback, on_error) => backend.read(start, length, callback, on_error),
        "write": (start, data, callback, on_error) => backend.write(start, data, callback, on_error),
        "flush": (callback, on_error) => backend.when_writes_done(callback, on_error),
        "reset": () => backend.reset(),
        "drop": () => block_drop_holds(backend),
    };
}

/**
 * The PCI function a plugin describes (register_pci), with the hooks of
 * src/pci.js that it may give
 * @param {!Object} owner { name, pci_id }
 * @param {!Object} description quoted { pci_space, pci_bars, pci_rom_size,
 *     pci_rom_address, on_command_change, on_config_restore,
 *     on_upstream_change, on_config_write }
 * @return {!Object}
 */
export function plugin_pci_device(owner, description)
{
    const device = {
        name: owner.name,
        pci_id: owner.pci_id,
        pci_space: description["pci_space"],
        pci_bars: description["pci_bars"].map(bar => bar && {
            size: bar["size"],
            on_move: bar["on_move"],
        }),
        pci_rom_size: description["pci_rom_size"],
        pci_rom_address: description["pci_rom_address"],
    };
    for(const hook of ["on_command_change", "on_config_restore", "on_upstream_change", "on_config_write"])
    {
        if(typeof description[hook] === "function") device[hook] = description[hook];
    }
    return device;
}

/**
 * A network or sound card from a plugin: v86's side of the device. The
 * machine puts it at `pci_id` (its kind's slot); the device's state is the
 * kind's snapshot slot ([tag, version, name, state]).
 * @constructor
 * @param {CPU} cpu
 * @param {PluginKind} kind
 * @param {!Object} descriptor from load_device_plugin
 * @param {number} pci_id
 * @param {!Object} extra the kind's part of the handle (quoted names)
 * @param {!Object} options the device's options (quoted names)
 */
export function PluginDevice(cpu, kind, descriptor, pci_id, extra, options)
{
    /** @const @type {CPU} */
    this.cpu = cpu;
    this.kind = kind;
    this.descriptor = descriptor;
    /** @const @type {string} */
    this.name = descriptor["name"];
    this.pci_id = pci_id;
    this.pci_device = null;

    const handle = Object.assign(device_handle(cpu, this), extra);
    this.device = descriptor["create"](handle, options);
    if(!this.device || typeof this.device["get_state"] !== "function" || typeof this.device["set_state"] !== "function")
    {
        throw new Error(kind.option + " \"" + this.name + "\": the plugin made no device");
    }
}

/**
 * @param {!Object} description quoted, see plugin_pci_device
 */
PluginDevice.prototype.register_pci = function(description)
{
    if(this.pci_device)
    {
        throw new Error(this.kind.option + " \"" + this.name + "\" registered its PCI function twice");
    }
    this.pci_device = plugin_pci_device(this, description);
    // (a reset of the function alone, e.g. a hot plugged card arriving)
    this.pci_device.reset = () => this.reset();
    dbg_log(this.kind.option + " \"" + this.name + "\" at PCI " + this.pci_id.toString(16), LOG_PCI);
    return this.cpu.devices.pci.register_device(this.pci_device);
};

/** A machine reset (PCIRST#): the plugin's optional reset hook */
PluginDevice.prototype.reset = function()
{
    const reset = this.device["reset"];
    if(typeof reset === "function") reset();
};

/** The machine goes away: the plugin's optional destroy hook */
PluginDevice.prototype.destroy = function()
{
    const destroy = this.device["destroy"];
    if(typeof destroy === "function") destroy();
};

PluginDevice.prototype.get_state = function()
{
    return [this.kind.tag, STATE_VERSION, this.name, this.device["get_state"]()];
};

/**
 * Throws if a snapshot's slot does not belong to this device. Changes
 * nothing, so that CPU.validate_state can call it before restoring anything.
 * @param {*} state
 */
PluginDevice.prototype.check_state = function(state)
{
    const saved = plugin_of_state(this.kind, state);
    if(saved !== this.name)
    {
        throw new Error("The snapshot is from a machine " + (saved === null ? "without " + this.kind.option + " \"" + this.name + "\"" :
            "with " + this.kind.option + ": \"" + saved + "\", this one has \"" + this.name + "\""));
    }
    if(state[1] !== STATE_VERSION)
    {
        throw new Error("Unsupported " + this.kind.option + " state version " + state[1]);
    }
};

/** @param {*} state */
PluginDevice.prototype.set_state = function(state)
{
    this.check_state(state);
    this.device["set_state"](state[3]);
};

/**
 * Which plugin a snapshot's slot belongs to: its name, or null if the slot is
 * not a plugin's (empty, or a built-in device's own state)
 * @param {PluginKind} kind
 * @param {*} state
 * @return {?string}
 */
export function plugin_of_state(kind, state)
{
    return Array.isArray(state) && state[0] === kind.tag ? state[2] : null;
}
