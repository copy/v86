import { wasm_fallback_path } from "./wasm_paths.js";
import { instantiate_v86, memory_import } from "../parallel/relocate.js";
import { default_worker_url, parallel_unsupported_reason } from "../parallel/machine.js";
import { CPUWorkerController, encode_worker_file } from "./cpu_worker.js";
import { get_jit_switches } from "../jit_switches.js";
import { v86 } from "../main.js";
import { LOG_CPU, LOG_VGA, WASM_TABLE_OFFSET, WASM_TABLE_SIZE } from "../const.js";
import { get_rand_int, load_file, read_sized_string_from_mem } from "../lib.js";
import { dbg_assert, dbg_trace, dbg_log, set_log_level } from "../log.js";
import * as print_stats from "./print_stats.js";
import { Bus } from "../bus.js";
import { BOOT_ORDER_FD_FIRST, BOOT_ORDER_HD_FIRST, BOOT_ORDER_CD_FIRST } from "../rtc.js";
import { EEXIST, ENOENT } from "../../lib/9p.js";
import { check_graphics_adapter_options, load_graphics_adapter } from "../graphics_adapter.js";
import { check_machine_options } from "../machine_options.js";

import { SpeakerAdapter } from "./speaker.js";
import { NetworkAdapter } from "./network.js";
import { FetchNetworkAdapter } from "./fetch_network.js";
import { WispNetworkAdapter } from "./wisp_network.js";
import { KeyboardAdapter } from "./keyboard.js";
import { MouseAdapter } from "./mouse.js";
import { ScreenAdapter } from "./screen.js";
import { DummyScreenAdapter } from "./dummy_screen.js";
import { ANSIScreenAdapter } from "./ansi_screen.js";
import { SerialAdapter, VirtioConsoleAdapter, SerialAdapterXtermJS, VirtioConsoleAdapterXtermJS } from "./serial.js";
import { InBrowserNetworkAdapter } from "./inbrowser_network.js";
import { Modem } from "./modem.js";

import { MemoryFileStorage, ServerFileStorageWrapper } from "./filestorage.js";
import { SyncBuffer, buffer_from_object } from "../buffer.js";
// (for types only)
import { PCIeRootPort } from "../pcie_root_port.js";
import { FS } from "../../lib/filesystem.js";

/**
 * graphics_adapter selects the display hardware the guest sees (a plugin,
 * src/graphics_adapter.js); graphics_proxy adds the D3D/DDraw/GL proxy of
 * libv86-webgpu.js, which the page loads first, as xterm.js for a serial
 * terminal (docs/glbridge.md)
 * @return {Object} the proxy's device plugin, or null
 */
function create_graphics_proxy(options)
{
    if(options["v86gl_pci"] !== undefined)
    {
        throw new Error("v86gl_pci was removed; use graphics_proxy: true");
    }
    if(options["graphics_options"] !== undefined)
    {
        throw new Error("graphics_options was removed; pass them as graphics_proxy: { ... }");
    }
    const proxy = options["graphics_proxy"];
    if(!proxy) return null;
    const factory = globalThis["V86GraphicsProxy"];
    if(typeof factory !== "function")
    {
        throw new Error("graphics_proxy requires libv86-webgpu.js to be loaded before new V86()");
    }
    return factory(proxy === true ? {} : proxy);
}

/** The name of the channel between the display adapter's device and its renderer, with a CPU worker */
export const ADAPTER_RENDERER_CHANNEL = "graphics_adapter_renderer";

/**
 * The 3D renderer of the display adapter, on this page: GX (V86SVGARenderer
 * of libv86-webgpu.js), for vmware_svga and virtio_gpu (virgl), when the
 * page has loaded it and WebGPU has an adapter. The device then declares 3D.
 *
 * With a CPU worker the device is in the worker and the renderer stays here:
 * `host` is this page's end of their channel (CPUWorkerController's
 * device_channel), and the worker gives the device the other end. In the
 * worker, `options` brings that end (graphics_adapter_renderer_channel).
 * @param {Object=} options
 * @param {Object=} host
 * @return {!Promise<Object>} the device's end of the channel (`host`
 *     itself if it was given), or null
 */
V86.prototype.create_adapter_renderer = async function(options, host)
{
    const remote = options && options["graphics_adapter_renderer_channel"];
    if(remote) return remote;
    const create = globalThis["V86SVGARenderer"];
    const gpu = typeof navigator !== "undefined" && navigator["gpu"];
    if(this.graphics_adapter !== "vmware_svga" && this.graphics_adapter !== "virtio_gpu" || typeof create !== "function" || !gpu) return null;
    let adapter = null;
    try
    {
        adapter = await gpu["requestAdapter"]();
    }
    catch(e)
    {
        dbg_log("WebGPU: " + e, LOG_VGA);
    }
    if(!adapter || this.destroyed) return null;
    if(host)
    {
        this.adapter_renderer = create(host, {});
        return host;
    }
    const channel = create_local_channel();
    this.adapter_renderer = create(channel.host, {});
    return channel.device;
};

/**
 * The ends of a channel between a plugin's device and its host side on one
 * thread: a message arrives before post returns, and may hold views of guest RAM
 */
function create_local_channel()
{
    const handlers = [null, null];
    const end = (self, other) => ({
        "remote": false,
        "post": (message, transfer) => { handlers[other] && handlers[other](message); },
        "listen": handler => { handlers[self] = handler; },
    });
    return { device: end(0, 1), host: end(1, 0) };
}

/**
 * Check a loaded core (docs/arm64-virt-android16-plan.md P1.3): the ARM core
 * exports the ISA marker isa_aarch64, the x86 core does not, and the core's
 * own table entries end below WASM_TABLE_OFFSET, where compiled code's begin
 * @param {!Object} exports
 * @param {string} cpu_type
 * @param {WebAssembly.Table} wasm_table
 */
function check_core(exports, cpu_type, wasm_table)
{
    const arm = !!exports["isa_aarch64"];
    if(arm !== (cpu_type === "arm64"))
    {
        throw new Error("The Wasm core is the " + (arm ? "ARM" : "x86") + " core (" + (arm ? "v86-arm64.wasm" : "v86.wasm") +
            "), cpu_type is \"" + cpu_type + "\": wasm_path names the wrong file");
    }
    if(wasm_table && wasm_table.length > WASM_TABLE_OFFSET && wasm_table.get(WASM_TABLE_OFFSET - 1) !== null)
    {
        throw new Error("The Wasm core's own table entries reach WASM_TABLE_OFFSET (" + WASM_TABLE_OFFSET + "): raise it in src/const.js");
    }
}

/**
 * Constructor for emulator instances.
 *
 * For API usage, see v86.d.ts in the root of this repository.
 *
 * @param {{
      disable_mouse: (boolean|undefined),
      disable_keyboard: (boolean|undefined),
      wasm_fn: (Function|undefined),
      screen: ({
          scale: (number|undefined),
      } | undefined),
    }} options
 * @constructor
 */
export function V86(options)
{
    if(typeof options.log_level === "number")
    {
        // XXX: Shared between all emulator instances
        set_log_level(options.log_level);
    }

    this.cpu_is_running = false;
    this.destroyed = false;
    this.cpu_exception_hook = function(n) {};

    // The display adapter is required; its plugin loads with the other files
    this.graphics_adapter = check_graphics_adapter_options(options);
    // the guest CPU, the machine and the options that belong to them
    // (src/machine_options.js; CPU.init checks again)
    const machine = check_machine_options(options);
    this.cpu_type = machine.cpu_type;
    this.machine_type = machine.machine_type;

    const bus = Bus.create();
    this.bus = bus[0];
    this.emulator_bus = bus[1];
    if(options["worker_bus_setup"]) options["worker_bus_setup"](this);

    // Device plugins: a virtio device next to the CPU and a host side here,
    // talking over a channel (docs/graphics-proxy-plugin-plan.md)
    this["graphics_proxy"] = create_graphics_proxy(options);
    this.device_plugins = this["graphics_proxy"] ? [this["graphics_proxy"]] : [];
    /** the display adapter's 3D renderer on this page (create_adapter_renderer) */
    this.adapter_renderer = null;
    this.plugins_ready = [];

    if(options["cpu_worker"] && typeof Worker !== "undefined")
    {
        this.worker_controller = new CPUWorkerController(this, options);
        this.continue_init(null, options).catch(error => this.worker_controller.fail(error));
        return;
    }

    var cpu;
    var wasm_memory;

    // Host-parallel execution of the application processors (docs/multicore.md), an
    // internal option: `true` forces it (tests: it fails where it cannot
    // run), "auto" uses it where the host can and otherwise keeps the
    // requested cores cooperative; get_diagnostics() reports the choice.
    const parallel_option = options["parallel"];
    this.parallel_forced = parallel_option === true;
    this.parallel_requested = false;
    this.parallel_fallback = "not requested";
    if(parallel_option === true || parallel_option === "auto")
    {
        const reason = (options.cpu_cores || 1) <= 1 ? "one core" :
            options.cpu_clock && options.cpu_clock["mode"] === "deterministic" ? "deterministic clock" :
            parallel_unsupported_reason(options.cpu_cores);
        if(!reason || this.parallel_forced) this.parallel_requested = true;
        this.parallel_fallback = reason;
    }

    const wasm_table = new WebAssembly.Table({ element: "anyfunc", initial: WASM_TABLE_SIZE + WASM_TABLE_OFFSET });

    const wasm_shared_funcs = {
        "cpu_exception_hook": n => this.cpu_exception_hook(n),
        "run_hardware_timers": function(a, t) { return cpu.run_hardware_timers(a, t); },
        "cpu_event_halt": () => { this.emulator_bus.send("cpu-event-halt"); },
        "abort": function() { dbg_assert(false); },
        "microtick": () => cpu ? cpu.clock.now() : v86.microtick(),
        "get_rand_int": function() { return get_rand_int(); },
        "stop_idling": function() { return cpu.stop_idling(); },
        // (cores built before the wide-native path was removed import it:
        // the M1 baselines, docs/jit-unification-plan.md P1.2)
        "x64_native_discard": () => {},
        "jit_publish": (client, id, slot, pointer, length) => cpu.jit_publish(client, id, slot, pointer, length),

        "io_port_read8": function(addr) { return cpu.io.port_read8(addr); },
        "io_port_read16": function(addr) { return cpu.io.port_read16(addr); },
        "io_port_read32": function(addr) { return cpu.io.port_read32(addr); },
        "io_port_write8": function(addr, value) { cpu.io.port_write8(addr, value); },
        "io_port_write16": function(addr, value) { cpu.io.port_write16(addr, value); },
        "io_port_write32": function(addr, value) { cpu.io.port_write32(addr, value); },

        "mmap_read8": function(addr) { return cpu.mmap_read8(addr); },
        "mmap_read32": function(addr) { return cpu.mmap_read32(addr); },
        "mmap_write8": function(addr, value) { cpu.mmap_write8(addr, value); },
        "mmap_write16": function(addr, value) { cpu.mmap_write16(addr, value); },
        "mmap_write32": function(addr, value) { cpu.mmap_write32(addr, value); },
        "mmap_write64": function(addr, value0, value1) { cpu.mmap_write64(addr, value0, value1); },
        "mmap_write128": function(addr, value0, value1, value2, value3) {
            cpu.mmap_write128(addr, value0, value1, value2, value3);
        },

        "log_from_wasm": function(offset, len) {
            const str = read_sized_string_from_mem(wasm_memory, offset, len);
            dbg_log(str, LOG_CPU);
        },
        "console_log_from_wasm": function(offset, len) {
            const str = read_sized_string_from_mem(wasm_memory, offset, len);
            console.error(str);
        },
        "dbg_trace_from_wasm": function() {
            dbg_trace(LOG_CPU);
        },

        // v86-parallel.wasm: wake a vCPU waiting on a word of the shared memory
        "parallel_notify": address => { Atomics.notify(new Int32Array(wasm_memory.buffer), address >>> 2); },
        // the ARM core: device registers of the virt machine (src/virt/io.js)
        "a64_mmio_read": (owner, offset, width) => cpu.io.mmio_read(owner, offset, width),
        "a64_mmio_write": (owner, offset, width, value) => { cpu.io.mmio_write(owner, offset, width, value); },
        // extended RAM pages (src/extended_memory.js)
        "extended_load": (page, pointer) => { cpu.extended_store.load(page, wasm_memory, pointer); },
        "extended_store": (page, pointer) => { cpu.extended_store.store(page, wasm_memory, pointer); },
        "jit_clear_func": (wasm_table_index) => cpu.jit_clear_func(wasm_table_index),

        "__indirect_function_table": wasm_table,
    };

    let wasm_fn = options.wasm_fn;

    if(!wasm_fn)
    {
        wasm_fn = env =>
        {
            /* global __dirname */

            return new Promise(resolve => {
                // the core of the CPU's family (docs/arm64-virt-android16-plan.md
                // P1.3): the ARM core for arm64, the x86 core otherwise; the
                // fallback stays in the family
                const arm = this.cpu_type === "arm64";
                let v86_bin = arm ? (DEBUG ? "v86-arm64-debug.wasm" : "v86-arm64.wasm") : DEBUG ? "v86-debug.wasm" : "v86.wasm";
                let v86_bin_fallback = arm ? "v86-arm64-fallback.wasm" : "v86-fallback.wasm";
                // cores in vCPU workers need the relocatable build (src/parallel);
                // "auto" falls back to the cooperative build
                if(this.parallel_requested)
                {
                    if(!this.parallel_forced) v86_bin_fallback = v86_bin;
                    v86_bin = arm ? "v86-arm64-parallel.wasm" : "v86-parallel.wasm";
                }

                // (tests: V86_WASM selects another build, e.g. build/v86-parallel.wasm)
                const wasm_path = options.wasm_path ||
                    typeof process !== "undefined" && process.env && process.env["V86_WASM"];
                if(wasm_path)
                {
                    v86_bin = wasm_path;
                    v86_bin_fallback = wasm_fallback_path(v86_bin);
                }
                else if(typeof window === "undefined" && typeof __dirname === "string")
                {
                    v86_bin = __dirname + "/" + v86_bin;
                    v86_bin_fallback = __dirname + "/" + v86_bin_fallback;
                }
                else
                {
                    v86_bin = "build/" + v86_bin;
                    v86_bin_fallback = "build/" + v86_bin_fallback;
                }

                v86_bin_fallback = options["wasm_fallback_path"] || v86_bin_fallback;
                // an explicit wasm_path is the cooperative build: with cores in
                // workers, parallel_wasm_path replaces it ("auto" falls back to it)
                if(this.parallel_requested && options["parallel_wasm_path"])
                {
                    if(!this.parallel_forced) v86_bin_fallback = v86_bin;
                    v86_bin = options["parallel_wasm_path"];
                }

                load_file(v86_bin, {
                    // ("auto": v86-parallel.wasm is not there)
                    error: this.parallel_requested && !this.parallel_forced ? () => load_file(v86_bin_fallback, {
                        done: async bytes => {
                            const { instance } = await instantiate_v86(bytes, env);
                            this.wasm_source = bytes;
                            resolve(instance.exports);
                        },
                    }) : undefined,
                    done: async bytes =>
                    {
                        try
                        {
                            const { instance } = await instantiate_v86(bytes, env);
                            this.wasm_source = bytes;
                            resolve(instance.exports);
                        }
                        catch(err)
                        {
                            load_file(v86_bin_fallback, {
                                    done: async bytes => {
                                        const { instance } = await instantiate_v86(bytes, env);
                                        this.wasm_source = bytes;
                                        resolve(instance.exports);
                                    },
                                });
                        }
                    },
                    progress: e =>
                    {
                        this.emulator_bus.send("download-progress", {
                            file_index: 0,
                            file_count: 1,
                            file_name: v86_bin,

                            lengthComputable: e.lengthComputable,
                            total: e.total,
                            loaded: e.loaded,
                        });
                    }
                });
            });
        };
    }

    Promise.resolve().then(() => wasm_fn({ "env": wasm_shared_funcs }))
        .then((exports) => {
            if(this.destroyed) return;
            check_core(exports, this.cpu_type, wasm_table);
            wasm_memory = exports.memory;
            exports["rust_init"]();

            const emulator = this.v86 = new v86(this.emulator_bus, { exports, wasm_table });
            cpu = emulator.cpu;

            return this.continue_init(emulator, options);
        }).catch(error => {
            if(!this.destroyed) this.emulator_bus.send("emulator-error", error);
        });

    this.zstd_worker = null;
    this.zstd_worker_request_id = 0;
}

V86.prototype.continue_init = async function(emulator, options)
{
    this.bus.register("emulator-stopped", function()
    {
        this.cpu_is_running = false;
        this.screen_adapter.pause();
    }, this);

    this.bus.register("emulator-started", function()
    {
        this.cpu_is_running = true;
        this.screen_adapter.continue();
    }, this);

    var settings = {};

    const boot_order =
        options.boot_order ? options.boot_order :
        options.fda ? BOOT_ORDER_FD_FIRST :
        options.hda ? BOOT_ORDER_HD_FIRST : BOOT_ORDER_CD_FIRST;

    if(options.modem)
    {
        settings.modem = options.modem;
        switch(options.modem.uart)
        {
            case 1:
                options.uart1 = true;
                break;
            case 2:
                options.uart2 = true;
                break;
            case 3:
                options.uart3 = true;
                break;
        }
    }

    settings.acpi = options.acpi;
    settings.machine_type = this.machine_type;
    settings.pcie_root_ports = options.pcie_root_ports;
    settings.hpet = options.hpet;
    settings.smbus = options.smbus;
    settings["ahci_test_drives"] = options["ahci_test_drives"]; // (tests only, see cpu.js)
    settings["ahci_test_pci_id"] = options["ahci_test_pci_id"];
    settings.cpu_cores = options.cpu_cores;
    settings.qemu_compatible = options.qemu_compatible;
    settings.parallel = this.parallel_requested;
    settings.parallel_fault = options["parallel_fault"];   // (test hook, src/parallel/vcpu.js)
    settings.cpu_clock = options.cpu_clock;
    settings.cpu_quantum = options.cpu_quantum;
    settings.cpu_schedule_seed = options.cpu_schedule_seed;
    settings.experimental_smp_jit = options.experimental_smp_jit;
    settings["cpu_type"] = this.cpu_type;
    settings["cpu_features"] = options["cpu_features"];
    settings["cpu_features_unreleased"] = options["cpu_features_unreleased"]; // (tests and development)
    settings["jit_switches"] = options["jit_switches"]; // (src/jit_switches.js)
    settings.disable_jit = options.disable_jit;
    settings["jit_backend"] = options["jit_backend"];
    // (ir_region_budget, ir_stats, ir_verify, ir_dump, ir_opt_level,
    // ir_passes_disabled and ir_page_mode are deprecated and ignored: the IR
    // region tiers went in docs/jit-unification-plan.md M11)
    settings["ir_sync_publication"] = options["ir_sync_publication"];
    settings["ir_tier0"] = options["ir_tier0"];
    settings["x87_fast_math"] = options["x87_fast_math"];
    settings["x87_jit_cache"] = options["x87_jit_cache"];
    settings.load_devices = true;
    settings.memory_size = options.memory_size || 64 * 1024 * 1024;
    settings.high_memory_size = options.high_memory_size;
    settings.extended_memory_size = options.extended_memory_size;
    settings.extended_memory_cache = options.extended_memory_cache;
    settings.vram_size = options["vram_size"];
    // (internal, see src/graphics_adapter.js)
    settings.graphics_adapter_test = options["graphics_adapter_test"];
    settings.boot_order = boot_order;
    settings.fastboot = options.fastboot || false;
    settings.bootmenu = options.bootmenu || false;
    settings.fda = undefined;
    settings.fdb = undefined;
    settings.uart1 = options.uart1;
    settings.uart2 = options.uart2;
    settings.uart3 = options.uart3;
    settings.parallel1 = options.parallel1;
    settings.cmdline = options.cmdline;
    settings.preserve_mac_from_state_image = options.preserve_mac_from_state_image;
    settings.mac_address_translation = options.mac_address_translation;
    settings.cpuid_level = options.cpuid_level;
    settings.virtio_balloon = options.virtio_balloon;
    settings.virtio_console = !!options.virtio_console;

    const relay_url = options.network_relay_url || options.net_device && options.net_device.relay_url;
    if(relay_url)
    {
        // TODO: remove bus, use direct calls instead
        if(relay_url === "fetch")
        {
            this.network_adapter = new FetchNetworkAdapter(this.bus, options.net_device);
        }
        else if(relay_url === "inbrowser")
        {
            // NOTE: experimental, will change when usage of options.net_device gets refactored in favour of emulator.bus
            this.network_adapter = new InBrowserNetworkAdapter(this.bus, options.net_device);
        }
        else if(relay_url.startsWith("wisp://") || relay_url.startsWith("wisps://"))
        {
            this.network_adapter = new WispNetworkAdapter(relay_url, this.bus, options.net_device);
        }
        else
        {
            this.network_adapter = new NetworkAdapter(relay_url, this.bus);
        }
    }

    // Enable unconditionally, so that state images don't miss hardware
    // TODO: Should be properly fixed in restore_state
    // (the virt machine: only when asked for, since its virtio devices take
    // the virtio-mmio slots in order, as the reference's -device options do)
    settings.net_device = options.net_device || { type: this.cpu_type === "arm64" ? "none" : "ne2k" };
    // the virt machine's virtio-blk disks (P5.4) and virtio-rng (P5.5)
    // (src/machine_options.js refuses them on the PC machines)
    if(options.virtio_disks) settings.virtio_disks = [];
    if(options.virtio_rng) settings.virtio_rng = true;
    // (their transport: virtio-mmio or the PCIe host, P5.7)
    if(options.virtio_transport) settings.virtio_transport = options.virtio_transport;
    // (virtio-input: a keyboard and a tablet, or the kinds listed, P5.8, P7.4)
    if(options.virtio_input) settings.virtio_input = Array.isArray(options.virtio_input) ? options.virtio_input.slice() : true;

    // built-in devices behind PCI Express root ports (machine_type "q35"):
    // pcie_root_port of their options, and pcie_plugged (false: the slot
    // starts empty; attach_pcie_device plugs the device in)
    settings.root_port_devices = {};
    for(const [name, device_options] of [["net", options.net_device], ["virtio_9p", options.filesystem],
        ["virtio_console", options.virtio_console], ["virtio_balloon", options.virtio_balloon]])
    {
        if(device_options && typeof device_options === "object" && device_options.pcie_root_port !== undefined)
        {
            settings.root_port_devices[name] = { port: device_options.pcie_root_port, plugged: device_options.pcie_plugged !== false };
        }
    }

    const screen_options = options.screen || {};
    if(options.screen_container)
    {
        screen_options.container = options.screen_container;
    }

    if(!options.disable_keyboard)
    {
        this.keyboard_adapter = new KeyboardAdapter(this.bus);
    }
    if(!options.disable_mouse)
    {
        this.mouse_adapter = new MouseAdapter(this.bus, screen_options.container);
    }

    // Pointer lock is not needed while the guest uses absolute pointer
    // positions (the guest cursor follows the host cursor), so release it
    // when the guest driver enables absolute positioning
    this.absolute_pointer_enabled = false;
    this.bus.register("vmware-absolute-mouse", function(enabled)
    {
        if(enabled && !this.absolute_pointer_enabled &&
            typeof document !== "undefined" && document.pointerLockElement)
        {
            document.exitPointerLock();
        }
        this.absolute_pointer_enabled = enabled;
    }, this);

    if(options["screen_adapter"])
    {
        this.screen_adapter = options["screen_adapter"];
    }
    else if(screen_options.container)
    {
        this.screen_container = screen_options.container;
        // A plugin that draws the screen (graphics_proxy's compositor) owns the canvas:
        // the screen waits for it
        screen_options.deferred_backend = this.device_plugins.some(plugin => plugin["wants_screen"]);
        this.screen_adapter = new ScreenAdapter(screen_options, full => this.worker_controller ? this.worker_controller.request_frame(full) :
            this.v86.cpu.devices.display && this.v86.cpu.devices.display.request_frame(full));
    }
    else if(screen_options.ansi)
    {
        this.screen_adapter = new ANSIScreenAdapter(screen_options);
    }
    else
    {
        this.screen_adapter = new DummyScreenAdapter(screen_options);
    }
    settings.screen = this.screen_adapter;
    settings.screen_options = screen_options;

    // Plugins are not compiled with v86: every name they see is quoted
    const plugin_devices = [];
    for(const plugin of this.device_plugins)
    {
        // With a CPU worker the device is made there, from the plugin's worker_script
        const channel = this.worker_controller ?
            { device: null, host: this.worker_controller.device_channel(plugin["name"]) } :
            create_local_channel();
        let screen = null;
        if(plugin["wants_screen"])
        {
            const screen_adapter = this.screen_adapter;
            if(!screen_adapter.claim_canvas)
            {
                throw new Error(plugin["name"] + " needs a browser screen container");
            }
            screen = {
                "canvas": screen_adapter.claim_canvas("webgpu"),
                // Once its renderer is up, or back to the 2D canvas if it cannot start
                "set_backend": backend => screen_adapter.set_backend(backend),
                "fallback": () => screen_adapter.use_canvas2d(),
                "is_graphical": () => screen_adapter.is_graphical(),
            };
        }
        try
        {
            if(!this.worker_controller) plugin_devices.push(plugin["create_device"](channel.device));
            this.plugins_ready.push(Promise.resolve(
                plugin["start"]({ "emulator": this, "screen": screen, "channel": channel.host })));
        }
        catch(error)
        {
            if(screen) this.screen_adapter.use_canvas2d();
            throw error;
        }
    }
    if(this.device_plugins.some(plugin => plugin["screen_changed"]))
    {
        this.screen_adapter.on_geometry_change = () => {
            for(const plugin of this.device_plugins)
            {
                plugin["screen_changed"] && plugin["screen_changed"]();
            }
        };
    }
    settings.virtio_devices = plugin_devices.length ?
        (options["virtio_devices"] || []).concat(plugin_devices) : options["virtio_devices"];

    settings.serial_console = options.serial_console || { type: "none" };

    // NOTE: serial_container_xtermjs and serial_container are deprecated
    if(options.serial_container_xtermjs)
    {
        settings.serial_console.type = "xtermjs";
        settings.serial_console.container = options.serial_container_xtermjs;
    }
    else if(options.serial_container)
    {
        settings.serial_console.type = "textarea";
        settings.serial_console.container = options.serial_container;
    }

    if(settings.serial_console?.type === "xtermjs")
    {
        const xterm_lib = settings.serial_console.xterm_lib || window["Terminal"];
        this.serial_adapter = new SerialAdapterXtermJS(settings.serial_console.container, this.bus, xterm_lib);
    }
    else if(settings.serial_console?.type === "textarea")
    {
        this.serial_adapter = new SerialAdapter(settings.serial_console.container, this.bus);
        //this.recording_adapter = new SerialRecordingAdapter(this.bus);
    }

    const virtio_console_settings = (options.virtio_console && typeof options.virtio_console === "boolean") ? { type: "none" } : options.virtio_console;

    if(virtio_console_settings?.type === "xtermjs")
    {
        const xterm_lib = virtio_console_settings.xterm_lib || window["Terminal"];
        this.virtio_console_adapter = new VirtioConsoleAdapterXtermJS(virtio_console_settings.container, this.bus, xterm_lib);
    }
    else if(virtio_console_settings?.type === "textarea")
    {
        this.virtio_console_adapter = new VirtioConsoleAdapter(virtio_console_settings.container, this.bus);
    }

    if(settings.modem)
    {
        this.modem = new Modem(this.bus, settings.modem);
    }

    if(!options.disable_speaker)
    {
        this.speaker_adapter = new SpeakerAdapter(this.bus);
    }

    if(this.worker_controller)
    {
        this.serial_adapter?.show?.();
        this.virtio_console_adapter?.show?.();
        this.modem?.initialize();
        // the display adapter's renderer stays on this page (WebGPU is here)
        this.worker_controller.adapter_renderer = !!await this.create_adapter_renderer(undefined,
            this.worker_controller.device_channel(ADAPTER_RENDERER_CHANNEL));
        await this.worker_controller.start();
        return;
    }

    // The display adapter's plugin, fetched while the files load, and its 3D
    // renderer if it has one and WebGPU works
    const graphics_adapter = this.graphics_adapter === "none" ? Promise.resolve(undefined) :
        load_graphics_adapter(this.graphics_adapter, options["graphics_adapter_path"]);
    graphics_adapter.catch(() => {});
    const adapter_renderer = this.create_adapter_renderer(options);

    // ugly, but required for closure compiler compilation
    function put_on_settings(name, buffer)
    {
        // (virtio_disks[i]: "virtio_disk" + i)
        if(name.startsWith("virtio_disk"))
        {
            const i = +name.slice("virtio_disk".length);
            const disk = options.virtio_disks[i];
            settings.virtio_disks[i] = { buffer, id: disk.id, readonly: !!disk.readonly };
            return;
        }
        switch(name)
        {
            case "hda":
                settings.hda = buffer;
                break;
            case "hdb":
                settings.hdb = buffer;
                break;
            case "cdrom":
                settings.cdrom = buffer;
                break;
            case "fda":
                settings.fda = buffer;
                break;
            case "fdb":
                settings.fdb = buffer;
                break;

            case "multiboot":
                settings.multiboot = buffer.buffer;
                break;
            case "bzimage":
                settings.bzimage = buffer.buffer;
                break;
            case "initrd":
                settings.initrd = buffer.buffer;
                break;
            // machine_type "virt" (src/virt/loader.js)
            case "kernel":
                settings.kernel = buffer.buffer;
                break;
            case "dtb":
                settings.dtb = buffer.buffer;
                break;

            case "bios":
                settings.bios = buffer.buffer;
                break;
            case "vga_bios":
                settings.vga_bios = buffer.buffer;
                break;
            case "initial_state":
                settings.initial_state = buffer.buffer;
                break;
            case "fs9p_json":
                settings.fs9p_json = buffer;
                break;
            default:
                dbg_assert(false, name);
        }
    }

    var files_to_load = [];

    const add_file = (name, file) =>
    {
        if(!file)
        {
            return;
        }

        if(file.get && file.set && file.load)
        {
            files_to_load.push({
                name: name,
                loadable: file,
            });
            return;
        }

        if(name === "bios" || name === "vga_bios" ||
            name === "initial_state" || name === "multiboot" ||
            name === "bzimage" || name === "initrd" || name === "kernel" || name === "dtb")
        {
            // Ignore async for these because they must be available before boot.
            // This should make result.buffer available after the object is loaded
            file.async = false;
        }

        if(name === "fda" || name === "fdb")
        {
            // small, doesn't make sense loading asynchronously
            file.async = false;
        }

        if(file.url && !file.async)
        {
            files_to_load.push({
                name: name,
                url: file.url,
                size: file.size,
            });
        }
        else
        {
            files_to_load.push({
                name,
                loadable: buffer_from_object(file, this.zstd_decompress_worker.bind(this)),
            });
        }
    };

    if(options.state)
    {
        console.warn("Warning: Unknown option 'state'. Did you mean 'initial_state'?");
    }

    add_file("bios", options.bios);
    add_file("vga_bios", options.vga_bios);
    add_file("cdrom", options.cdrom);
    add_file("hda", options.hda);
    add_file("hdb", options.hdb);
    add_file("fda", options.fda);
    add_file("fdb", options.fdb);
    add_file("initial_state", options.initial_state);
    add_file("multiboot", options.multiboot);
    add_file("bzimage", options.bzimage);
    add_file("initrd", options.initrd);
    add_file("kernel", options.kernel);
    add_file("dtb", options.dtb);
    // the virt machine's virtio-blk disks: {url or buffer, async, size, id,
    // readonly}; the buffer an ArrayBuffer, a File, or a buffer object of
    // its own (get, set, load), as hda may be
    (options.virtio_disks || []).forEach((disk, i) =>
    {
        const own = disk.buffer && disk.buffer.get && disk.buffer.set && disk.buffer.load;
        add_file("virtio_disk" + i, own ? disk.buffer : disk);
    });

    if(options.filesystem && options.filesystem.handle9p)
    {
        settings.handle9p = options.filesystem.handle9p;
    }
    else if(options.filesystem && options.filesystem.proxy_url)
    {
        settings.proxy9p = options.filesystem.proxy_url;
    }
    else if(options.filesystem)
    {
        var fs_url = options.filesystem.basefs;
        var base_url = options.filesystem.baseurl;

        let file_storage = new MemoryFileStorage();

        if(base_url)
        {
            file_storage = new ServerFileStorageWrapper(file_storage, base_url, this.zstd_decompress.bind(this));
        }
        settings.fs9p = this.fs9p = new FS(file_storage);

        if(fs_url)
        {
            dbg_assert(base_url, "Filesystem: baseurl must be specified");

            var size;

            if(typeof fs_url === "object")
            {
                size = fs_url.size;
                fs_url = fs_url.url;
            }
            dbg_assert(typeof fs_url === "string");

            files_to_load.push({
                name: "fs9p_json",
                url: fs_url,
                size: size,
                as_json: true,
            });
        }
    }

    var starter = this;
    var total = files_to_load.length;
    let resolve_initialized, reject_initialized;
    const initialized = new Promise((resolve, reject) => {
        resolve_initialized = resolve;
        reject_initialized = reject;
    });

    var cont = function(index)
    {
        if(index === total)
        {
            setTimeout(() => done.call(this).then(resolve_initialized, reject_initialized), 0);
            return;
        }

        var f = files_to_load[index];

        if(f.loadable)
        {
            f.loadable.onload = function(e)
            {
                put_on_settings.call(this, f.name, f.loadable);
                cont(index + 1);
            }.bind(this);
            f.loadable.load();
        }
        else
        {
            load_file(f.url, {
                done: function(result)
                {
                    if(f.url.endsWith(".zst") && f.name !== "initial_state")
                    {
                        dbg_assert(f.size, "A size must be provided for compressed images");
                        result = this.zstd_decompress(f.size, new Uint8Array(result));
                    }

                    put_on_settings.call(this, f.name, f.as_json ? result : new SyncBuffer(result));
                    cont(index + 1);
                }.bind(this),
                progress: function progress(e)
                {
                    if(e.target.status === 200)
                    {
                        starter.emulator_bus.send("download-progress", {
                            file_index: index,
                            file_count: total,
                            file_name: f.url,

                            lengthComputable: e.lengthComputable,
                            total: e.total || f.size,
                            loaded: e.loaded,
                        });
                    }
                    else
                    {
                        starter.emulator_bus.send("download-error", {
                            file_index: index,
                            file_count: total,
                            file_name: f.url,
                            request: e.target,
                        });
                    }
                },
                as_json: f.as_json,
            });
        }
    }.bind(this);
    cont(0);
    return initialized;

    async function done()
    {
        //if(settings.initial_state)
        //{
        //    // avoid large allocation now, memory will be restored later anyway
        //    settings.memory_size = 0;
        //}

        if(settings.fs9p && settings.fs9p_json)
        {
            if(!settings.initial_state)
            {
                settings.fs9p.load_from_json(settings.fs9p_json);

                if(options.bzimage_initrd_from_filesystem)
                {
                    const { bzimage_path, initrd_path } = this.get_bzimage_initrd_from_filesystem(settings.fs9p);

                    dbg_log("Found bzimage: " + bzimage_path + " and initrd: " + initrd_path);

                    const [initrd, bzimage] = await Promise.all([
                        settings.fs9p.read_file(initrd_path),
                        settings.fs9p.read_file(bzimage_path),
                    ]);
                    put_on_settings.call(this, "initrd", new SyncBuffer(initrd.buffer));
                    put_on_settings.call(this, "bzimage", new SyncBuffer(bzimage.buffer));
                }
            }
            else
            {
                dbg_log("Filesystem basefs ignored: Overridden by state image");
            }
        }
        else
        {
            dbg_assert(
                !options.bzimage_initrd_from_filesystem || settings.initial_state,
                "bzimage_initrd_from_filesystem: Requires a filesystem");
        }

        this.serial_adapter && this.serial_adapter.show && this.serial_adapter.show();
        this.virtio_console_adapter && this.virtio_console_adapter.show && this.virtio_console_adapter.show();

        if(!settings.initial_state)
        {
            // ide needs to read the mbr to calculate the device geometry
            if(settings.hda)
            {
                await new Promise(resolve => settings.hda.get_and_cache(0, 512, resolve));
            }
            if(settings.hdb)
            {
                await new Promise(resolve => settings.hdb.get_and_cache(0, 512, resolve));
            }
        }

        settings.graphics_adapter = await graphics_adapter;
        settings.graphics_adapter_renderer = await adapter_renderer;

        if(this.destroyed) return;
        this.v86.init(settings);

        const parallel_bytes = this.parallel_requested && this.wasm_source && new Uint8Array(this.wasm_source);
        if(this.parallel_requested && (!parallel_bytes || !memory_import(parallel_bytes)?.shared))
        {
            if(this.parallel_forced) throw new Error("parallel: the CPU core is not v86-parallel.wasm");
            this.parallel_requested = false;
            this.parallel_fallback = "v86-parallel.wasm unavailable";
        }
        this.v86.cpu.parallel_fallback = this.parallel_requested ? "" : this.parallel_fallback;
        if(this.parallel_requested)
        {
            // application processors in vCPU workers (src/parallel/machine.js)
            const bytes = parallel_bytes;
            const worker_settings = {};
            for(const key of ["disable_jit", "jit_backend", "ir_tier0", "cpu_type", "x87_fast_math", "x87_jit_cache",
                "cpuid_level", "cpu_quantum", "parallel_fault"])
            {
                if(settings[key] !== undefined) worker_settings[key] = settings[key];
            }
            // the JIT switches set on the machine (src/jit_switches.js)
            worker_settings["jit_switches"] = get_jit_switches(this.v86.cpu.wm.exports, this.v86.cpu.wasm_memory, true);
            // (the same compiler policy as the machine's core, see CPU.prototype.init)
            worker_settings["disable_jit"] = !!settings.disable_jit || !settings.experimental_smp_jit;
            await this.v86.cpu.start_parallel({ bytes, settings: worker_settings,
                worker_url: options["vcpu_worker_url"] || await default_worker_url() });
            if(this.destroyed) return;
        }

        await Promise.all(this.plugins_ready);
        if(this.destroyed) return;

        this.modem && this.modem.initialize();

        if(settings.initial_state)
        {
            await this.restore_state(settings.initial_state);

            // The GC can't free settings, since it is referenced from
            // several closures. This isn't needed anymore, so we delete it
            // here
            settings.initial_state = undefined;
        }

        if(options.autostart)
        {
            this.v86.run();
        }

        this.emulator_bus.send("emulator-loaded");
    }
};

/**
 * @param {number} decompressed_size
 * @param {Uint8Array} src
 * @return {ArrayBuffer}
 */
V86.prototype.zstd_decompress = function(decompressed_size, src)
{
    const cpu = this.v86.cpu;

    dbg_assert(!this.zstd_context);
    this.zstd_context = cpu.zstd_create_ctx(src.length);

    new Uint8Array(cpu.wasm_memory.buffer).set(src, cpu.zstd_get_src_ptr(this.zstd_context));

    const ptr = cpu.zstd_read(this.zstd_context, decompressed_size);
    const result = cpu.wasm_memory.buffer.slice(ptr, ptr + decompressed_size);
    cpu.zstd_read_free(ptr, decompressed_size);

    cpu.zstd_free_ctx(this.zstd_context);
    this.zstd_context = null;

    return result;
};

/**
 * @param {number} decompressed_size
 * @param {Uint8Array} src
 * @return {Promise<ArrayBuffer>}
 */
V86.prototype.zstd_decompress_worker = async function(decompressed_size, src)
{
    if(!this.zstd_worker)
    {
        function the_worker()
        {
            let wasm;

            // The limits of the imported table and memory (the import section)
            function import_limits(bytes)
            {
                let at = 8;
                const uleb = () => { let result = 0, shift = 0, byte; do { byte = bytes[at++]; result += (byte & 0x7F) * 2 ** shift; shift += 7; } while(byte & 0x80); return result; };
                const name = () => { const n = uleb(); at += n; };
                const result = { table: 0, memory: null };
                while(at < bytes.length)
                {
                    const id = bytes[at++], size = uleb(), end = at + size;
                    if(id === 2)
                    {
                        for(let count = uleb(); count--;)
                        {
                            name(); name();
                            const kind = bytes[at++];
                            if(kind === 0) uleb();
                            else if(kind === 1) { at++; const flags = uleb(); result.table = uleb(); if(flags & 1) uleb(); }
                            else if(kind === 2) { const flags = uleb(); const initial = uleb(); const maximum = flags & 1 ? uleb() : undefined; result.memory = { initial, maximum, shared: !!(flags & 2) }; }
                            else if(kind === 3) at += 2;
                        }
                        return result;
                    }
                    at = end;
                }
                return result;
            }

            globalThis.onmessage = function(e)
            {
                if(!wasm)
                {
                    // Every import of the core (whichever it is: x86 or ARM,
                    // cooperative or parallel) gets a stand-in: functions
                    // that must not run, the table and memory with the
                    // limits the module declares (the parallel core imports
                    // a shared memory)
                    const module = new WebAssembly.Module(e.data);
                    const limits = import_limits(new Uint8Array(e.data));
                    const env = {};
                    let memory = null;
                    for(const { name, kind } of WebAssembly.Module.imports(module))
                    {
                        if(kind === "function")
                        {
                            env[name] = () => console.error("zstd worker unexpectedly called " + name);
                        }
                        else if(kind === "table")
                        {
                            env[name] = new WebAssembly.Table({ element: "anyfunc", initial: limits.table || 0 });
                        }
                        else if(kind === "memory")
                        {
                            const m = limits.memory;
                            env[name] = memory = new WebAssembly.Memory(m.shared ?
                                { initial: m.initial, maximum: m.maximum, shared: true } : { initial: m.initial });
                        }
                    }
                    env["abort"] = () => { throw new Error("zstd worker aborted"); };
                    env["log_from_wasm"] = env["console_log_from_wasm"] = (off, len) => {
                        console.log(read_sized_string_from_mem((memory || wasm.exports.memory).buffer, off, len));
                    };
                    env["dbg_trace_from_wasm"] = () => console.trace();

                    const instance = new WebAssembly.Instance(module, { "env": env });
                    wasm = { exports: memory && !instance.exports.memory ? Object.assign({ memory }, instance.exports) : instance.exports };
                    return;
                }

                const { src, decompressed_size, id } = e.data;
                const exports = wasm.exports;

                const zstd_context = exports["zstd_create_ctx"](src.length);
                new Uint8Array(exports.memory.buffer).set(src, exports["zstd_get_src_ptr"](zstd_context));

                const ptr = exports["zstd_read"](zstd_context, decompressed_size);
                const result = exports.memory.buffer.slice(ptr, ptr + decompressed_size);
                exports["zstd_read_free"](ptr, decompressed_size);

                exports["zstd_free_ctx"](zstd_context);

                postMessage({ result, id }, [result]);
            };
        }

        const url = URL.createObjectURL(new Blob(["(" + the_worker.toString() + ")()"], { type: "text/javascript" }));
        this.zstd_worker = new Worker(url);
        URL.revokeObjectURL(url);
        this.zstd_worker.postMessage(this.wasm_source, [this.wasm_source]);
    }

    return new Promise(resolve => {
        const id = this.zstd_worker_request_id++;
        const done = async e =>
        {
            if(e.data.id === id)
            {
                this.zstd_worker.removeEventListener("message", done);
                dbg_assert(decompressed_size === e.data.result.byteLength);
                resolve(e.data.result);
            }
        };
        this.zstd_worker.addEventListener("message", done);
        this.zstd_worker.postMessage({ src, decompressed_size, id }, [src.buffer]);
    });
};

V86.prototype.get_bzimage_initrd_from_filesystem = function(filesystem)
{
    const root = (filesystem.read_dir("/") || []).map(x => "/" + x);
    const boot = (filesystem.read_dir("/boot/") || []).map(x => "/boot/" + x);

    let initrd_path;
    let bzimage_path;

    for(const f of [].concat(root, boot))
    {
        const old = /old/i.test(f) || /fallback/i.test(f);
        const is_bzimage = /vmlinuz/i.test(f) || /bzimage/i.test(f);
        const is_initrd = /initrd/i.test(f) || /initramfs/i.test(f);

        if(is_bzimage && (!bzimage_path || !old))
        {
            bzimage_path = f;
        }

        if(is_initrd && (!initrd_path || !old))
        {
            initrd_path = f;
        }
    }

    if(!initrd_path || !bzimage_path)
    {
        console.log("Failed to find bzimage or initrd in filesystem. Files:");
        console.log(root.join(" "));
        console.log(boot.join(" "));
    }

    return { initrd_path, bzimage_path };
};

/**
 * Start emulation. Do nothing if emulator is running already. Can be asynchronous.
 */
V86.prototype.run = async function()
{
    if(this.worker_controller) return this.worker_controller.serialize(() => this.worker_controller.rpc("run"));
    this.v86.run();
};

/**
 * Stop emulation. Do nothing if emulator is not running. Can be asynchronous.
 */
V86.prototype.stop = async function()
{
    if(this.worker_controller) return this.worker_controller.serialize(() => this.worker_controller.stop());
    if(!this.cpu_is_running)
    {
        return;
    }

    await new Promise(resolve => {
        const listener = () => {
            this.remove_listener("emulator-stopped", listener);
            resolve();
        };
        this.add_listener("emulator-stopped", listener);
        this.v86.stop();
    });
    // cores in vCPU workers stop at their next safe point: wait for it, so
    // that the stopped machine's state is the one its cores are in
    const cpu = this.v86.cpu;
    // (after a vCPU failed there is no consistent state to capture)
    if(cpu.parallel && !cpu.parallel.failure && !this.v86.running)
    {
        await cpu.parallel.park();
        if(!this.v86.running) cpu.parallel_capture();
    }
};

/**
 * Free resources associated with this instance
 */
V86.prototype.destroy = async function()
{
    this.destroyed = true;
    if(this.worker_controller) await this.worker_controller.destroy();
    else await this.stop();
    if(this.device_state_operation) await this.device_state_operation;

    for(const plugin of this.device_plugins)
    {
        plugin["destroy"] && await plugin["destroy"]();
    }
    this.adapter_renderer && this.adapter_renderer["destroy"]();
    this.v86 && this.v86.destroy();
    this.keyboard_adapter && this.keyboard_adapter.destroy();
    this.network_adapter && this.network_adapter.destroy();
    this.mouse_adapter && this.mouse_adapter.destroy();
    this.screen_adapter && this.screen_adapter.destroy();
    this.serial_adapter && this.serial_adapter.destroy();
    this.speaker_adapter && this.speaker_adapter.destroy();
    this.virtio_console_adapter && this.virtio_console_adapter.destroy();
    this.modem && this.modem.destroy();
};

/**
 * Restart (force a reboot).
 * @param {string=} reason "power-on" after the guest turned the machine off
 */
V86.prototype.restart = async function(reason)
{
    if(this.worker_controller) return this.worker_controller.state("restart", reason);
    if(!this.device_plugins.length) return this.v86.restart(reason);
    return this.with_device_state(async () => {
        for(const plugin of this.device_plugins)
        {
            plugin["reset"] && await plugin["reset"]();
        }
        this.v86.restart(reason);
    }, false);
};

/**
 * Diagnostic snapshot of the machine (CPU mode and registers, interrupt
 * controllers, ACPI device and tables) as plain data. For debugging and test
 * reports; the format is not a stable API.
 */
V86.prototype.get_diagnostics = async function()
{
    if(this.worker_controller) return this.worker_controller.rpc("get_diagnostics");
    return this.v86.cpu.get_diagnostics();
};

/**
 * Press the ACPI power button. A running ACPI guest gets a power button event
 * (usually starting an orderly shutdown). A machine that the guest has turned
 * off (event "acpi-power-off"; the virt machine: PSCI SYSTEM_OFF) is powered
 * on and started again. Resolves to false if the machine has no ACPI (option
 * acpi) and is not off.
 */
/**
 * The ACPI power state: "S0", "S3" (suspended to RAM), "S4" (hibernated and
 * off) or "S5" (soft off).
 * @return {Promise<string>}
 */
V86.prototype.power_state = async function()
{
    if(this.worker_controller) return this.worker_controller.rpc("power_state");
    const acpi = this.v86.cpu.devices.acpi;
    // (the virt machine: PSCI SYSTEM_OFF, the machine's power hook)
    if(!acpi) return this.v86.cpu.powered_off() ? "S5" : "S0";
    return acpi.sleeping ? "S3" : acpi.soft_off ? "S" + acpi.soft_off : "S0";
};

V86.prototype.power_button = async function()
{
    if(this.worker_controller) return this.worker_controller.serialize(() => this.worker_controller.rpc("power_button"));
    const acpi = this.v86.cpu.devices.acpi;
    if(!acpi)
    {
        // (the virt machine has no power button; one the guest turned off
        // with PSCI SYSTEM_OFF is powered on and started again)
        if(this.v86.cpu.powered_off && this.v86.cpu.powered_off())
        {
            await this.restart("power-on");
            await this.run();
            return true;
        }
        return false;
    }
    if(acpi.soft_off)
    {
        // power-on after S4/S5: RAM does not keep its contents
        await this.restart("power-on");
        await this.run();
    }
    else
    {
        acpi.press_power_button();
    }
    return true;
};

/**
 * Add an event listener (the emulator is an event emitter).
 *
 * The callback function gets a single argument which depends on the event.
 *
 * @param {string} event Name of the event.
 * @param {function(?)} listener The callback function.
 */
V86.prototype.add_listener = function(event, listener)
{
    this.bus.register(event, listener, this);
};

/**
 * Remove an event listener.
 *
 * @param {string} event
 * @param {function(*)} listener
 */
V86.prototype.remove_listener = function(event, listener)
{
    this.bus.unregister(event, listener);
};

/**
 * Restore the emulator state from the given state, which must be an
 * ArrayBuffer returned by
 * [`save_state`](#save_statefunctionobject-arraybuffer-callback).
 *
 * Note that the state can only be restored correctly if this constructor has
 * been created with the same options as the original instance (e.g., same disk
 * images, memory size, etc.).
 *
 * Different versions of the emulator might use a different format for the
 * state buffer.
 *
 * @param {ArrayBuffer} state
 */
V86.prototype.restore_state = async function(state)
{
    if(this.worker_controller) return this.worker_controller.state("restore", state);
    dbg_assert(arguments.length === 1);
    if(!this.device_plugins.length) return this.v86.restore_state(state);
    return this.with_device_state(() => this.restore_with_plugins(() => this.v86.restore_state(state)), false);
};

/**
 * Asynchronously save the current state of the emulator.
 *
 * @return {Promise<ArrayBuffer>}
 */
V86.prototype.save_state = async function()
{
    if(this.worker_controller) return this.worker_controller.state("save");
    dbg_assert(arguments.length === 0);
    if(!this.device_plugins.length && !this.adapter_host_state()) return this.v86.save_state();
    return this.with_device_state(async () => {
        if(this.adapter_host_state()) await this.v86.cpu.devices.graphics_adapter.prepare_save();
        return this.save_with_plugins(() => this.v86.save_state());
    }, true);
};

/**
 * Save a V7 snapshot with bounded RAM buffers and writer backpressure.
 * @param {function(!Uint8Array): (void|!Promise<void>)} write
 * @return {!Promise<void>}
 */
V86.prototype.save_state_stream = async function(write)
{
    if(typeof write !== "function") throw new TypeError("Snapshot writer must be a function");
    if(this.worker_controller) return this.worker_controller.state_stream("save", write);
    if(!this.device_plugins.length && !this.adapter_host_state()) return this.v86.save_state_stream(write);
    return this.with_device_state(async () => {
        if(this.adapter_host_state()) await this.v86.cpu.devices.graphics_adapter.prepare_save();
        return this.save_with_plugins(() => this.v86.save_state_stream(write));
    }, true);
};

/**
 * Restore a V7 stream from a Blob or a random-access byte source.
 * A read failure during restoration leaves the machine stopped.
 * @param {*} source
 * @return {!Promise<void>}
 */
V86.prototype.restore_state_stream = async function(source)
{
    if(this.worker_controller) return this.worker_controller.state_stream("restore", source);
    if(!this.device_plugins.length) return this.v86.restore_state_stream(source);
    return this.with_device_state(() => this.restore_with_plugins(() => this.v86.restore_state_stream(source)), false);
};

/**
 * Whether the display adapter keeps state on the GPU that a snapshot fetches
 * @return {boolean}
 */
V86.prototype.adapter_host_state = function()
{
    const adapter = this.v86 && this.v86.cpu.devices.graphics_adapter;
    return !!adapter && adapter.has_host_state();
};

/**
 * The CPU side of a device plugin
 * @param {!Object} plugin
 */
V86.prototype.plugin_device = function(plugin)
{
    return this.v86.cpu.devices.virtio_devices.find(device => device.name === plugin["name"]);
};

/**
 * Each plugin's host state goes into the snapshot with its device
 * @param {function():!Promise<*>} save
 */
V86.prototype.save_with_plugins = async function(save)
{
    try
    {
        for(const plugin of this.device_plugins)
        {
            this.plugin_device(plugin).host_state = plugin["prepare_save"] ? await plugin["prepare_save"]() : undefined;
        }
        return await save();
    }
    finally
    {
        for(const plugin of this.device_plugins)
        {
            this.plugin_device(plugin).host_state = undefined;
            plugin["release_save"] && plugin["release_save"]();
        }
    }
};

/**
 * @param {function():!Promise<*>} restore
 */
V86.prototype.restore_with_plugins = async function(restore)
{
    try
    {
        for(const plugin of this.device_plugins)
        {
            plugin["before_restore"] && await plugin["before_restore"]();
        }
        await restore();
        for(const plugin of this.device_plugins)
        {
            const device = this.plugin_device(plugin);
            const host_state = device.restored_host_state;
            device.restored_host_state = undefined;
            plugin["after_restore"] && await plugin["after_restore"](host_state);
        }
    }
    catch(error)
    {
        for(const plugin of this.device_plugins)
        {
            plugin["cancel_restore"] && plugin["cancel_restore"]();
        }
        throw error;
    }
};

// Serialize saves/restores and pause the CPU while plugins can still write
// guest RAM. A failed restore leaves the CPU stopped; a failed save resumes
// the untouched guest.
V86.prototype.with_device_state = function(operation, resume_on_error)
{
    const previous = this.device_state_operation || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
        if(this.destroyed) throw new Error("Emulator has been destroyed");
        const was_running = this.is_running();
        await this.stop();
        if(this.speaker_adapter) await this.speaker_adapter.pause();
        let success = false;
        try
        {
            const result = await operation();
            success = true;
            return result;
        }
        finally
        {
            if(was_running && !this.destroyed && (success || resume_on_error)) this.run();
        }
    });
    // Keep only a completion barrier, not the potentially large saved buffer.
    this.device_state_operation = next.then(() => {}, () => {});
    return next;
};

/**
 * @return {number}
 * @ignore
 */
V86.prototype.get_instruction_counter = function()
{
    if(this.worker_controller) return this.worker_controller.instructions;
    if(this.v86)
    {
        return this.v86.cpu.instruction_counter[0] >>> 0;
    }
    else
    {
        // TODO: Should be handled using events
        return 0;
    }
};

/**
 * @return {boolean}
 */
V86.prototype.is_running = function()
{
    return this.cpu_is_running;
};

/**
 * Set the image inserted in the floppy drive. Can be changed at runtime, as
 * when physically changing the floppy disk.
 */
V86.prototype.set_fda = async function(file)
{
    if(this.worker_controller) return this.worker_controller.rpc("set_fda", [encode_worker_file(file)]);
    const fda = this.v86.cpu.devices.fdc.drives[0];
    if(file.url && !file.async)
    {
        await new Promise(resolve => {
            load_file(file.url, {
                done: result =>
                {
                    fda.insert_disk(new SyncBuffer(result));
                    resolve();
                }
            });
        });
    }
    else
    {
        const image = buffer_from_object(file, this.zstd_decompress_worker.bind(this));
        image.onload = () =>
        {
            fda.insert_disk(image);
        };
        await image.load();
    }
};

/**
 * Set the image inserted in the second floppy drive, also at runtime.
 */
V86.prototype.set_fdb = async function(file)
{
    if(this.worker_controller) return this.worker_controller.rpc("set_fdb", [encode_worker_file(file)]);
    const fdb = this.v86.cpu.devices.fdc.drives[1];
    if(file.url && !file.async)
    {
        await new Promise(resolve => {
            load_file(file.url, {
                done: result =>
                {
                    fdb.insert_disk(new SyncBuffer(result));
                    resolve();
                }
            });
        });
    }
    else
    {
        const image = buffer_from_object(file, this.zstd_decompress_worker.bind(this));
        image.onload = () =>
        {
            fdb.insert_disk(image);
        };
        await image.load();
    }
};

/**
 * Eject floppy drive fda.
 */
V86.prototype.eject_fda = function()
{
    if(this.worker_controller) return this.worker_controller.rpc("eject_fda");
    this.v86.cpu.devices.fdc.drives[0].eject_disk();
};

/**
 * Eject second floppy drive fdb.
 */
V86.prototype.eject_fdb = function()
{
    if(this.worker_controller) return this.worker_controller.rpc("eject_fdb");
    this.v86.cpu.devices.fdc.drives[1].eject_disk();
};

/**
 * Return buffer object of floppy disk of drive fda or null if the drive is empty.
 * @return {Uint8Array|null}
 */
V86.prototype.get_disk_fda = function()
{
    if(this.worker_controller) return this.worker_controller.rpc("get_disk_fda");
    return this.v86.cpu.devices.fdc.drives[0].get_buffer();
};

/**
 * Return buffer object of second floppy disk of drive fdb or null if the drive is empty.
 * @return {Uint8Array|null}
 */
V86.prototype.get_disk_fdb = function()
{
    if(this.worker_controller) return this.worker_controller.rpc("get_disk_fdb");
    return this.v86.cpu.devices.fdc.drives[1].get_buffer();
};

/**
 * Set the image inserted in the CD-ROM drive. Can be changed at runtime, as
 * when physically changing the CD-ROM.
 */
V86.prototype.set_cdrom = async function(file)
{
    if(this.worker_controller) return this.worker_controller.rpc("set_cdrom", [encode_worker_file(file)]);
    if(file.url && !file.async)
    {
        await new Promise(resolve => load_file(file.url, {
            done: result =>
            {
                this.v86.cpu.devices.cdrom.set_cdrom(new SyncBuffer(result));
                resolve();
            },
        }));
    }
    else
    {
        const image = buffer_from_object(file, this.zstd_decompress_worker.bind(this));
        image.onload = () =>
        {
            this.v86.cpu.devices.cdrom.set_cdrom(image);
        };
        await image.load();
    }
};

/**
 * Eject the CD-ROM.
 */
V86.prototype.eject_cdrom = function()
{
    if(this.worker_controller) return this.worker_controller.rpc("eject_cdrom");
    this.v86.cpu.devices.cdrom.eject();
};

/**
 * Hot plug a drive into a free SATA port of the Q35 machine's AHCI
 * controller (ports 0-5; hda, hdb and cdrom are on ports 0, 1 and 2). The
 * guest sees the link come up and finds the drive by resetting the port, as
 * with a drive plugged into a hot plug capable port.
 *
 * A snapshot holds the drives on the ports. To restore one taken with a hot
 * plugged drive, attach the same image to the same port first; otherwise the
 * restored guest sees the drive removed.
 *
 * @param {number} port
 * @param {Object|null} file the image, as for the hda option; for a CD drive
 *     the disc, or null for an empty drive
 * @param {{cdrom: (boolean|undefined)}=} options cdrom: an ATAPI CD drive
 */
V86.prototype.attach_sata_drive = async function(port, file, options)
{
    const cdrom = !!(options && options.cdrom);
    if(this.worker_controller) return this.worker_controller.rpc("attach_sata_drive", [port, encode_worker_file(file), { "cdrom": cdrom }]);
    const ahci = this.v86.cpu.devices.ahci;
    if(!ahci) throw new Error("attach_sata_drive: no AHCI controller (machine_type: \"q35\")");
    if(!file && !cdrom) throw new Error("attach_sata_drive: a disk needs an image");
    let image;
    if(file && file.url && !file.async)
    {
        image = await new Promise(resolve => load_file(file.url, { done: result => resolve(new SyncBuffer(result)) }));
    }
    else if(file)
    {
        // (a descriptor as for the hda option, or a buffer object of one's own)
        image = await new Promise((resolve, reject) => {
            const buffer = file.get && file.set && file.load ? file : buffer_from_object(file, this.zstd_decompress_worker.bind(this));
            if(!buffer) throw new Error("attach_sata_drive: not a disk image");
            buffer.onload = () => resolve(buffer);
            Promise.resolve(buffer.load()).catch(reject);
        });
    }
    if(image && !cdrom)
    {
        // (the disk's CHS geometry comes from its partition table)
        await new Promise(resolve => image.get_and_cache(0, 512, resolve));
    }
    ahci.attach(port, { buffer: image, is_cdrom: cdrom });
};

/**
 * Remove the drive of a SATA port of the Q35 machine (a surprise removal,
 * as when pulling a drive out of a hot plug capable port). Writes the guest
 * issued before are in the image; the guest learns of the removal from the
 * link going down.
 *
 * @param {number} port
 */
V86.prototype.detach_sata_drive = function(port)
{
    if(this.worker_controller) return this.worker_controller.rpc("detach_sata_drive", [port]);
    const ahci = this.v86.cpu.devices.ahci;
    if(!ahci) throw new Error("detach_sata_drive: no AHCI controller (machine_type: \"q35\")");
    ahci.detach(port);
};

/**
 * Plug a card into a PCI Express root port of the Q35 machine: the device
 * whose options put it behind that port (pcie_root_port), after it was
 * pulled out or when it started out (pcie_plugged: false). The guest sees a
 * card inserted into a hot plug slot, and the device starts afresh: in a slot
 * that is off (empty slots are after reset, as in QEMU), presence detect
 * changed and the attention button pressed (as QEMU), and the guest switches
 * the slot on; in a powered slot, presence detect changed and the link comes
 * up. Guests need PCI Express native hot plug (Linux: pciehp; the ACPI tables
 * grant it through _OSC).
 *
 * A snapshot holds which slots have their card in.
 *
 * @param {number} port
 */
V86.prototype.attach_pcie_device = async function(port)
{
    if(this.worker_controller) return this.worker_controller.rpc("attach_pcie_device", [port]);
    root_port_of(this, port, "attach_pcie_device").insert();
};

/**
 * Pull the card out of a PCI Express root port of the Q35 machine. By
 * default, as with the slot's attention button: the guest releases the
 * device and switches the slot and its power indicator off, then the card
 * leaves (Linux and Windows wait 5 seconds for a second press, which would
 * cancel), and the promise is fulfilled. A guest without hot plug never does; surprise: true pulls the
 * card at once, as from a slot without a button. (Reads from a card that is
 * gone return all ones; Linux's virtio drivers, as of 6.18, then wait forever
 * for the device's reset: take virtio devices out with the button.)
 *
 * @param {number} port
 * @param {{surprise: (boolean|undefined)}=} options
 * @return {!Promise<void>}
 */
V86.prototype.detach_pcie_device = async function(port, options)
{
    const surprise = !!(options && options.surprise);
    if(this.worker_controller) return this.worker_controller.detach_pcie_device(port, surprise);
    await root_port_of(this, port, "detach_pcie_device").remove(surprise);
};

/**
 * @param {V86} emulator
 * @param {number} port
 * @param {string} caller
 * @return {PCIeRootPort}
 */
function root_port_of(emulator, port, caller)
{
    const ports = emulator.v86.cpu.devices.pcie_root_ports || [];
    if(!ports[port])
    {
        throw new Error(caller + ": no root port " + port + " (machine_type \"q35\", pcie_root_ports: " + ports.length + ")");
    }
    return ports[port];
}

/**
 * Send a sequence of scan codes to the emulated PS2 controller. A list of
 * codes can be found at http://stanislavs.org/helppc/make_codes.html.
 * Do nothing if there is no keyboard controller.
 *
 * @param {Array.<number>} codes
 * @param {number=} delay
 */
V86.prototype.keyboard_send_scancodes = async function(codes, delay)
{
    for(var i = 0; i < codes.length; i++)
    {
        this.bus.send("keyboard-code", codes[i]);
        if(delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
};

/**
 * Send translated keys
 * @param {Array.<number>} codes
 * @param {number=} delay
 */
V86.prototype.keyboard_send_keys = async function(codes, delay)
{
    for(var i = 0; i < codes.length; i++)
    {
        this.keyboard_adapter.simulate_press(codes[i]);
        if(delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
};

/**
 * Send text, assuming the guest OS uses a US keyboard layout
 * @param {string} string
 * @param {number=} delay
 */
V86.prototype.keyboard_send_text = async function(string, delay)
{
    for(var i = 0; i < string.length; i++)
    {
        this.keyboard_adapter.simulate_char(string[i]);
        if(delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
};

/**
 * Download a screenshot (returns an <img> element, only works in browsers)
 */
V86.prototype.screen_make_screenshot = function()
{
    for(const plugin of this.device_plugins)
    {
        const image = plugin["screenshot"] && plugin["screenshot"]();
        if(image) return image;
    }
    if(this.screen_adapter)
    {
        return this.screen_adapter.make_screenshot();
    }
    return null;
};

/**
 * Set the scaling level of the emulated screen.
 *
 * @param {number} sx
 * @param {number} sy
 */
V86.prototype.screen_set_scale = function(sx, sy)
{
    if(this.screen_adapter)
    {
        this.screen_adapter.set_scale(sx, sy);
    }
};

/**
 * Tell the display adapter what size the page would show the guest's display
 * at, such as the size of its window. Adapters that can ask the guest to
 * change its resolution do (virtio_gpu); the others ignore it.
 *
 * @param {number} width
 * @param {number} height
 * @param {number=} display which of the guest's displays (0, the first)
 */
V86.prototype.set_display_size = function(width, height, display)
{
    this.bus.send("display-host-size", [width >>> 0, height >>> 0, display >>> 0]);
};

/**
 * Go fullscreen (only browsers)
 */
V86.prototype.screen_go_fullscreen = function()
{
    if(!this.screen_adapter)
    {
        return;
    }

    // The configured container, whatever its id
    var elem = this.screen_container || this.screen_adapter.get_graphics_canvas &&
        this.screen_adapter.get_graphics_canvas().parentElement;

    if(!elem)
    {
        return;
    }

    // bracket notation because otherwise they get renamed by closure compiler
    var fn = elem["requestFullscreen"] || elem["requestFullScreen"] ||
            elem["webkitRequestFullscreen"] ||
            elem["mozRequestFullScreen"] ||
            elem["msRequestFullScreen"];

    if(fn)
    {
        fn.call(elem);

        // This is necessary, because otherwise chromium keyboard doesn't work anymore.
        // Might (but doesn't seem to) break something else
        var focus_element = document.getElementsByClassName("phone_keyboard")[0];
        focus_element && focus_element.focus();
    }

    try {
        navigator.keyboard.lock();
    } catch(e) {}

    this.lock_mouse();
};

/**
 * Lock the mouse cursor: It becomes invisble and is not moved out of the
 * browser window.
 */
V86.prototype.lock_mouse = async function()
{
    const elem = document.body;

    try
    {
        await elem.requestPointerLock({
            unadjustedMovement: true,
        });
    }
    catch(e)
    {
        // as per MDN, retry without unadjustedMovement option
        await elem.requestPointerLock();
    }
};

/**
 * Enable or disable sending mouse events to the emulated PS2 controller.
 *
 * @param {boolean} enabled
 */
V86.prototype.mouse_set_enabled = function(enabled)
{
    if(this.mouse_adapter)
    {
        this.mouse_adapter.emu_enabled = enabled;
        this.mouse_adapter.update_cursor();
    }
};
V86.prototype.mouse_set_status = V86.prototype.mouse_set_enabled;

/**
 * Enable or disable sending keyboard events to the emulated PS2 controller.
 *
 * @param {boolean} enabled
 */
V86.prototype.keyboard_set_enabled = function(enabled)
{
    if(this.keyboard_adapter)
    {
        this.keyboard_adapter.emu_enabled = enabled;
    }
};
V86.prototype.keyboard_set_status = V86.prototype.keyboard_set_enabled;

/**
 * Send a string to the first emulated serial terminal.
 *
 * @param {string} data
 */
V86.prototype.serial0_send = function(data)
{
    for(var i = 0; i < data.length; i++)
    {
        this.bus.send("serial0-input", data.charCodeAt(i));
    }
};

/**
 * Send bytes to a serial port (to be received by the emulated PC).
 *
 * @param {Uint8Array} data
 */
V86.prototype.serial_send_bytes = function(serial, data)
{
    for(var i = 0; i < data.length; i++)
    {
        this.bus.send("serial" + serial + "-input", data[i]);
    }
};

/**
 * Set or clear the data carrier detect (DCD) status of a serial port.
 *
 * @param {number} serial
 * @param {boolean} status
 */
V86.prototype.serial_set_carrier_detect = function(serial, status)
{
    this.bus.send("serial" + serial + "-carrier-detect-input", status);
};

/**
 * Set or clear the ring indicator (RING) status of a serial port.
 *
 * @param {number} serial
 * @param {boolean} status
 */
V86.prototype.serial_set_ring_indicator = function(serial, status)
{
    this.bus.send("serial" + serial + "-ring-indicator-input", status);
};

/**
 * Set or clear the data set ready (DSR) status of a serial port.
 *
 * @param {number} serial
 * @param {boolean} status
 */
V86.prototype.serial_set_data_set_ready = function(serial, status)
{
    this.bus.send("serial" + serial + "-data-set-ready-input", status);
};

/**
 * Set or clear the clear to send (CTS) status of a serial port.
 *
 * @param {number} serial
 * @param {boolean} status
 */
V86.prototype.serial_set_clear_to_send = function(serial, status)
{
    this.bus.send("serial" + serial + "-clear-to-send-input", status);
};

/**
 * Write to a file in the 9p filesystem. Nothing happens if no filesystem has
 * been initialized.
 *
 * @param {string} file
 * @param {Uint8Array} data
 */
V86.prototype.create_file = async function(file, data)
{
    if(this.worker_controller) return this.worker_controller.rpc("create_file", [file, data]);
    dbg_assert(arguments.length === 2);
    var fs = this.fs9p;

    if(!fs)
    {
        return;
    }

    var parts = file.split("/");
    var filename = parts[parts.length - 1];

    var path_infos = fs.SearchPath(file);
    var parent_id = path_infos.parentid;
    var not_found = filename === "" || parent_id === -1;

    if(!not_found)
    {
        await fs.CreateBinaryFile(filename, parent_id, data);
    }
    else
    {
        return Promise.reject(new FileNotFoundError());
    }
};

/**
 * Read a file in the 9p filesystem. Nothing happens if no filesystem has been
 * initialized.
 *
 * @param {string} file
 */
V86.prototype.read_file = async function(file)
{
    if(this.worker_controller) return this.worker_controller.rpc("read_file", [file]);
    dbg_assert(arguments.length === 1);
    var fs = this.fs9p;

    if(!fs)
    {
        return;
    }

    const result = await fs.read_file(file);

    if(result)
    {
        return result;
    }
    else
    {
        return Promise.reject(new FileNotFoundError());
    }
};

/*
 * @deprecated
 * Use wait_until_vga_screen_contains etc.
 */
V86.prototype.automatically = function(steps)
{
    const run = (steps) =>
    {
        const step = steps[0];

        if(!step)
        {
            return;
        }

        const remaining_steps = steps.slice(1);

        if(step.sleep)
        {
            setTimeout(() => run(remaining_steps), step.sleep * 1000);
            return;
        }

        if(step.vga_text)
        {
            this.wait_until_vga_screen_contains(step.vga_text).then(() => run(remaining_steps));
            return;
        }

        if(step.keyboard_send)
        {
            if(Array.isArray(step.keyboard_send))
            {
                this.keyboard_send_scancodes(step.keyboard_send);
            }
            else
            {
                dbg_assert(typeof step.keyboard_send === "string");
                this.keyboard_send_text(step.keyboard_send);
            }

            run(remaining_steps);
            return;
        }

        if(step.call)
        {
            step.call();
            run(remaining_steps);
            return;
        }

        dbg_assert(false, step);
    };

    run(steps);
};

/**
 * Wait until expected text is present on the VGA text screen.
 *
 * Returns immediately if the expected text is already present on screen
 * at the time this funtion is called.
 *
 * An optional timeout may be specified in `options.timeout_msec`, returns
 * false if the timeout expires before the expected text could be detected.
 *
 * Expected text (or texts, see below) must be of type string or RegExp,
 * strings are tested against the beginning of a screen line, regular
 * expressions against the full line but may use wildcards for partial
 * matching.
 *
 * Two methods of text detection are supported depending on the type of the
 * argument `expected`:
 *
 * 1. If `expected` is a string or RegExp then the given text string or
 *    regular expression may match any line on screen for this function
 *    to succeed.
 *
 * 2. If `expected` is an array of strings and/or RegExp objects then the
 *    list of expected lines must match exactly at "the bottom" of the
 *    screen. The "bottom" line is the first non-empty line starting from
 *    the screen's end.
 *    Expected lines should not contain any trailing whitespace and/or
 *    newline characters. Expecting an empty line is valid.
 *
 * Returns `true` on success and `false` when the timeout has expired.
 *
 * @param {string|RegExp|Array<string|RegExp>} expected
 * @param {{timeout_msec:(number|undefined)}=} options
 */
V86.prototype.wait_until_vga_screen_contains = async function(expected, options)
{
    if(this.graphics_adapter === "none")
    {
        throw new Error("wait_until_vga_screen_contains: there is no VGA text screen (graphics_adapter is \"none\")");
    }
    const match_multi = Array.isArray(expected);
    const timeout_msec = options?.timeout_msec || 0;
    const contains_expected = (screen_line, pattern) => pattern.test ? pattern.test(screen_line) : screen_line.startsWith(pattern);

    const screen_contains_expected = () =>
    {
        const screen = this.screen_adapter.get_text_screen();
        if(!match_multi)
        {
            return screen.some(screen_line => contains_expected(screen_line, expected));
        }

        const screen_lines = screen.map(screen_line => screen_line.trimRight());
        let screen_height = screen_lines.length;
        while(screen_height > 0 && screen_lines[screen_height - 1] === "")
        {
            screen_height--;
        }
        const screen_offset = screen_height - expected.length;
        if(screen_offset < 0)
        {
            return false;
        }
        for(let i = 0; i < expected.length; i++)
        {
            if(!contains_expected(screen_lines[screen_offset + i], expected[i]))
            {
                return false;
            }
        }
        return true;
    };

    // Read the whole screen again after any change: a mode set resizes the
    // text screen through transient sizes (80x256 while the VGA BIOS programs
    // the CRTC), so rows that changed earlier may no longer exist
    let screen_changed = false;
    const on_screen_change = () => { screen_changed = true; };
    this.add_listener("screen-put-char", on_screen_change);
    this.add_listener("screen-set-size", on_screen_change);

    let succeeded = screen_contains_expected();
    const end = timeout_msec ? performance.now() + timeout_msec : 0;
    while(!succeeded && (!end || performance.now() < end))
    {
        await new Promise(resolve => setTimeout(resolve, 100));

        if(screen_changed)
        {
            screen_changed = false;
            succeeded = screen_contains_expected();
        }
    }

    this.remove_listener("screen-put-char", on_screen_change);
    this.remove_listener("screen-set-size", on_screen_change);
    return succeeded;
};

/**
 * Reads data from memory at specified offset.
 *
 * @param {number} offset
 * @param {number} length
 * @returns
 */
V86.prototype.read_memory = function(offset, length)
{
    if(this.worker_controller) return this.worker_controller.rpc("read_memory", [offset, length]);
    return this.v86.cpu.read_blob_physical(offset, length);
};

/**
 * Writes data to memory at specified offset.
 *
 * @param {Array.<number>|Uint8Array} blob
 * @param {number} offset
 */
V86.prototype.write_memory = function(blob, offset)
{
    if(this.worker_controller) return this.worker_controller.rpc("write_memory", [blob, offset]);
    this.v86.cpu.write_blob_physical(blob, offset);
};

/** Read a physical range with bounded allocations, including addresses above 4 GiB.
 * @param {number} offset
 * @param {number} length
 * @param {number=} chunk_size
 */
V86.prototype.read_memory_chunks = async function*(offset, length, chunk_size = 1024 * 1024)
{
    // (the machine's physical address space: 36 bits on the PC machines, 40 on virt)
    const limit = this.cpu_type === "arm64" ? 0x10000000000 : 0x1000000000;
    if(!Number.isSafeInteger(offset) || offset < 0 || offset >= limit ||
        !Number.isSafeInteger(length) || length < 0 || offset + length > limit ||
        !Number.isInteger(chunk_size) || chunk_size < 1 || chunk_size > 16 * 1024 * 1024)
        throw new RangeError("Invalid physical range or chunk size");
    for(let done = 0; done < length; done += chunk_size)
        yield await this.read_memory(offset + done, Math.min(chunk_size, length - done));
};

/*
 * @param {HTMLElement} element
 * @param {Function} [xterm_lib]
 */
V86.prototype.set_serial_container_xtermjs = function(element, xterm_lib = window["Terminal"])
{
    this.serial_adapter && this.serial_adapter.destroy && this.serial_adapter.destroy();
    this.serial_adapter = new SerialAdapterXtermJS(element, this.bus, xterm_lib);
    this.serial_adapter.show();
};

/*
 * @param {HTMLElement} element
 * @param {Function} [xterm_lib]
 */
V86.prototype.set_virtio_console_container_xtermjs = function(element, xterm_lib = window["Terminal"])
{
    this.virtio_console_adapter && this.virtio_console_adapter.destroy && this.virtio_console_adapter.destroy();
    this.virtio_console_adapter = new VirtioConsoleAdapterXtermJS(element, this.bus, xterm_lib);
    this.virtio_console_adapter.show();
};

V86.prototype.get_instruction_stats = function()
{
    if(this.worker_controller) return this.worker_controller.rpc("get_instruction_stats");
    return print_stats.stats_to_string(this.v86.cpu);
};

/** Deprecated: the IR region tiers' diagnostics (docs/jit-unification-plan.md M11 deleted them). Returns false. */
V86.prototype.configure_ir_diagnostics = function(period)
{
    return false;
};
// eslint-disable-next-line no-self-assign -- Keep the public name through Closure compilation.
V86.prototype["configure_ir_diagnostics"] = V86.prototype.configure_ir_diagnostics;

/** Deprecated: the IR region tiers' compiler dumps (docs/jit-unification-plan.md M11 deleted them). Returns an empty list. */
V86.prototype.get_ir_dumps = function(clear = false)
{
    return [];
};
// eslint-disable-next-line no-self-assign -- Keep the public name through Closure compilation.
V86.prototype["get_ir_dumps"] = V86.prototype.get_ir_dumps;

/** Returns a copied runtime snapshot; in CPU Worker mode returns a Promise. */
V86.prototype.get_jit_info = function()
{
    if(this.worker_controller) return this.worker_controller.rpc("get_jit_info");
    return this.v86.cpu.get_jit_info();
};
// eslint-disable-next-line no-self-assign -- Keep the public name through Closure compilation.
V86.prototype["get_jit_info"] = V86.prototype.get_jit_info;

/**
 * @ignore
 * @constructor
 *
 * @param {string=} message
 */
function FileExistsError(message)
{
    this.message = message || "File already exists";
}
FileExistsError.prototype = Error.prototype;

/**
 * @ignore
 * @constructor
 *
 * @param {string=} message
 */
function FileNotFoundError(message)
{
    this.message = message || "File not found";
}
FileNotFoundError.prototype = Error.prototype;

/* global module, self */

// The optional graphics bundle uses these across the compilation boundary.
/* eslint-disable no-self-assign -- Quoted names export methods across Closure ADVANCED. */
V86.prototype["add_listener"] = V86.prototype.add_listener;
V86.prototype["remove_listener"] = V86.prototype.remove_listener;
V86.prototype["write_memory"] = V86.prototype.write_memory;
V86.prototype["read_memory_chunks"] = V86.prototype.read_memory_chunks;
V86.prototype["save_state_stream"] = V86.prototype.save_state_stream;
V86.prototype["restore_state_stream"] = V86.prototype.restore_state_stream;
/* eslint-enable no-self-assign */

if(typeof module !== "undefined" && typeof module.exports !== "undefined")
{
    module.exports["V86"] = V86;
}
else if(typeof window !== "undefined")
{
    window["V86"] = V86;
}
else if(typeof importScripts === "function")
{
    // web worker
    self["V86"] = V86;
}
