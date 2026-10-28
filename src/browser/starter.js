import { wasm_fallback_path } from "./wasm_paths.js";
import { instantiate_v86, memory_import } from "../parallel/relocate.js";
import { default_worker_url, parallel_unsupported_reason } from "../parallel/machine.js";
import { CPUWorkerController, encode_worker_file } from "./cpu_worker.js";
import * as iso9660 from "../iso9660.js";
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
import { AUDIO_PLUGINS, GLES_PLUGINS, NET_PLUGINS, TPM_PLUGINS, USB_PLUGINS, default_glslang_wasm_path, default_tpm_wasm_path,
    load_device_plugin } from "../device_plugin.js";
import { check_machine_options, is_arm, AUDIO_DEVICE_PLUGINS, NET_DEVICE_PLUGINS } from "../machine_options.js";

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
import { check_image_options, create_disk_image, import_ova, set_buffer_sector_size } from "../image/factory.js";
import { check_disk_options, check_disk_policy, check_disk_bindings, set_disk_policy, disk_kind, is_service_url } from "../disk_options.js";
import { NodeFileDisk, check_loaded_disks, disk_buffers } from "../disk_writeback.js";
import { floppy_format_size } from "../floppy.js";
import { DiskServiceDisk } from "../disk_service.js";
import { OpfsDisk, is_opfs_url, opfs_file } from "../opfs_disk.js";
// (for types only)
import { PCIeRootPort } from "../pcie_root_port.js";
import { android_bootloader, ANDROID_DEVICES } from "../android/bootloader.js";
import { DEFAULT_GLES_VERSION, GLES_VERSIONS, ranchu_gpu_mode } from "../android/devices.js";
import { PartitionBuffer } from "../android/partition_buffer.js";
import { FS } from "../../lib/filesystem.js";

/**
 * A whole file of a URL (load_file), or why it could not be loaded: an
 * answer of 4xx fails at once (a missing image must not hang the start or
 * become a disk; 5xx answers and network errors are tried again)
 * @param {string} name the option it is for (fda, cdrom, ...)
 * @param {string} url
 * @param {Object=} options more of load_file's options (progress, as_json)
 * @return {!Promise<*>}
 */
function load_whole_file(name, url, options)
{
    return new Promise((resolve, reject) => load_file(url, Object.assign({}, options, {
        done: resolve,
        error: status => reject(new Error(name + ": " + url + " could not be loaded (" +
            (typeof status === "number" ? "HTTP " + status : status) + ")")),
    })));
}

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
    if(this.graphics_adapter !== "vmware_svga" && this.graphics_adapter !== "virtio_gpu" && !this.gles_host || typeof create !== "function" || !gpu) return null;
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
    // (with the graphics proxy's compositor on this page: a layer of it, the
    // renderer on its device showing scanouts there without readbacks,
    // docs/gfxstream-plan.md G4; its plugin objects' names are quoted)
    let compositor = this.device_plugins.map(plugin => plugin["bridge"] && plugin["bridge"]["compositor"]).find(Boolean);
    // (the ranchu machine's GLES host without the graphics proxy: a
    // compositor of its own takes over the screen canvas, as the proxy's
    // does, so that a posted frame is a layer over the screen and is not read
    // back, docs/gles-proxy-plan.md E5; the 2D canvas again if it cannot start)
    if(!compositor && this.gles_host) compositor = await this.gles_screen_compositor();
    const layer = compositor ? compositor["createLayer"]("display adapter") : null;
    const renderer_options = layer ? { "canvas": layer["canvas"], "executorOptions": { "host": layer["host"] }, "scanoutLayer": layer } : {};
    if(host)
    {
        this.adapter_renderer = create(host, renderer_options);
        return host;
    }
    const channel = create_local_channel();
    this.adapter_renderer = create(channel.host, renderer_options);
    return channel.device;
};

/**
 * A WebGPU compositor of the screen canvas for the GLES host's frames
 * (create_adapter_renderer), when the page has the compositor
 * (libv86-webgpu.js) and a browser screen; null otherwise or if it fails
 * @return {!Promise<Object>}
 */
V86.prototype.gles_screen_compositor = async function()
{
    const Compositor = globalThis["V86WebGPUCompositor"], hosts = globalThis["V86GPUHost"];
    const screen_adapter = this.screen_adapter;
    if(typeof Compositor !== "function" || !hosts || !screen_adapter || !screen_adapter.claim_canvas) return null;
    const canvas = screen_adapter.claim_canvas("webgpu");
    const compositor = new Compositor(canvas);
    try
    {
        compositor["useHost"](hosts["acquire"](canvas, undefined));
        await compositor["attach"](hosts["acquire"](canvas, undefined));
    }
    catch(e)
    {
        dbg_log("GLES: the screen's compositor did not start (" + e + "): frames are read back", LOG_VGA);
        compositor["destroy"]();
        screen_adapter.use_canvas2d();
        return null;
    }
    if(this.destroyed)
    {
        compositor["destroy"]();
        return null;
    }
    screen_adapter.set_backend(compositor);
    this.gles_compositor = compositor;
    return compositor;
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
    if(arm !== is_arm(cpu_type))
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
    // the ranchu machine's GLES host (ranchu_gpu "host", or an emulator
    // image's GPU mode "host"): it needs the page's renderer, as a 3D
    // display adapter does (docs/gles-proxy-plan.md)
    const android_device = options.android && ANDROID_DEVICES[options.android.device || "cf_arm64_only_phone"];
    this.gles_host = options.ranchu_gpu === "host" || !!options.gles_backdoor || !!(android_device && android_device.machine === "ranchu" &&
        ranchu_gpu_mode(android_device, options.android.gpu_mode).ranchu_gpu === "host");
    // each disk's disk_option and disk_error (docs/disk-persistence-plan.md
    // "启动校验"); the disks, to find an image bound twice (attach_sata_drive)
    /** @type {!Array<!Array<*>>} [name, descriptor] */
    this.disk_descriptors = check_disk_options(options).map(([name, file]) => [name, file]);

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
    /** the GLES host's own compositor of the screen (gles_screen_compositor), or null */
    this.gles_compositor = null;
    this.plugins_ready = [];

    // the page goes away: the sessions of the disks written back to a disk
    // service are closed as far as the browser still sends it (completed
    // writes are in the image anyway; the service flushes when the lease ends)
    if(typeof window !== "undefined" && typeof window.addEventListener === "function")
    {
        this.pagehide_listener = () => this.pagehide_disks();
        window.addEventListener("pagehide", this.pagehide_listener);
    }

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
            options.cpu_clock && options.cpu_clock["rate"] !== undefined && options.cpu_clock["rate"] !== 1 ? "clock rate" :
            parallel_unsupported_reason(options.cpu_cores);
        // (cores in workers keep the host's time: a clock rate needs cooperative cores)
        if(reason === "clock rate" && this.parallel_forced) throw new Error("cpu_clock.rate: the cores must be cooperative, not parallel: true");
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
        // the arm32 GLES backdoor's calls (src/arm/backdoor_a32.js): r0 to r3, the answer for r0
        "a32_backdoor": (r0, r1, r2, r3) => cpu.backdoor_call(r0, r1, r2, r3),
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
                const arm = is_arm(this.cpu_type);
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

/**
 * The backend of a disk written back (docs/disk-persistence-plan.md): a
 * browser disk (opfs:, docs/vm-manager-plan.md U6), a disk service's URL,
 * or in Node a local file
 * @param {string} name
 * @param {!Object} file
 * @return {!Object}
 */
function writeback_backend(name, file)
{
    if(is_opfs_url(file.url))
    {
        return new OpfsDisk(file.url, { name, size: file.size });
    }
    if(is_service_url(file.url))
    {
        const base = typeof location !== "undefined" ? location.href : undefined;
        return new DiskServiceDisk(new URL(file.url, base).href, { name, token: file.token, size: file.size });
    }
    return new NodeFileDisk(file.url, { name, size: file.size });
}

/**
 * A browser disk (url "opfs:...") read only: its image as a File, read as a
 * file the user picked is, the changes in memory (src/opfs_disk.js)
 * @param {string} name
 * @param {?Object} file
 * @return {!Promise<?Object>}
 */
async function opfs_readable(name, file)
{
    if(!file || !is_opfs_url(file.url) || file.disk_option === "read_write") return file;
    const copy = Object.assign({}, file, { buffer: await opfs_file(file.url, name), async: true });
    delete copy.url;
    return copy;
}

V86.prototype.continue_init = async function(emulator, options)
{
    // (browser disks read only: their File, before the disks are made)
    options = Object.assign({}, options);
    for(const name of ["hda", "hdb", "cdrom", "fda", "fdb"])
    {
        options[name] = await opfs_readable(name, options[name]);
    }
    if(options.virtio_disks)
    {
        options.virtio_disks = await Promise.all(options.virtio_disks.map((disk, i) => opfs_readable("virtio_disk" + i, disk)));
    }
    if(options.usb && options.usb.mass_storage)
    {
        options.usb = Object.assign({}, options.usb, { mass_storage: await Promise.all(options.usb.mass_storage.map(async disk =>
            Object.assign({}, disk, { image: await opfs_readable("usb:" + disk.id, disk.image) }))) });
    }
    // android: { device, gpu_mode, selinux, vendor_ramdisk }: the kernel,
    // initrd and command line from the disk (docs/android-images-plan.md I2)
    if(options.android)
    {
        const android = options.android;
        if(android.device !== undefined && !ANDROID_DEVICES[android.device]) throw new Error("android.device: one of " + Object.keys(ANDROID_DEVICES).join(", "));
        // (the device's CPU and machine: Cuttlefish's arm64 virt, an emulator image's ranchu)
        const device = ANDROID_DEVICES[android.device || "cf_arm64_only_phone"];
        if(this.cpu_type !== device.cpu) throw new Error("android: " + device.id + " needs cpu_type \"" + device.cpu + "\"");
        if(this.machine_type !== device.machine) throw new Error("android: " + device.id + " needs machine_type \"" + device.machine + "\"");
        if(options.kernel || options.initrd || options.bzimage) throw new Error("android: the disk's boot partitions give the kernel and initrd (kernel and initrd left out)");
        if(!options.virtio_disks || !options.virtio_disks.length) throw new Error("android: the disk with the device's partitions is the first of virtio_disks");
        // (gfxstream: for the gfxstream device's development, docs/gfxstream-plan.md;
        // an emulator image's: guest or host, docs/gles-proxy-plan.md)
        const gpu_modes = device.machine === "ranchu" ? ["guest", "host", "swiftshader"] : ["swiftshader", "venus", "gfxstream"];
        if(android.gpu_mode !== undefined && !gpu_modes.includes(android.gpu_mode)) throw new Error("android.gpu_mode: " + gpu_modes.join(", "));
        if(android.selinux !== undefined && !["enforcing", "permissive"].includes(android.selinux)) throw new Error("android.selinux: enforcing or permissive");
        if(android.gles_version !== undefined && !GLES_VERSIONS[android.gles_version]) throw new Error("android.gles_version: " + Object.keys(GLES_VERSIONS).join(", "));
    }

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
    settings["cpu_profile"] = options["cpu_profile"]; // (the CPU model: src/machine_options.js, src/arm/cpu.js)
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
    settings.net_device = options.net_device || { type: is_arm(this.cpu_type) ? "none" : "ne2k" };
    // the sound card: the Sound Blaster 16 unless audio_device says otherwise
    settings.audio_device = is_arm(this.cpu_type) ? undefined : options.audio_device || "sb16";
    settings.usb = is_arm(this.cpu_type) ? undefined : options.usb || undefined;
    settings.tpm = is_arm(this.cpu_type) ? undefined : options.tpm || undefined;
    // the UEFI firmware (docs/uefi.md); its images arrive as firmware_code and firmware_vars
    settings.firmware = options.firmware && options.firmware.type === "uefi" ? options.firmware : undefined;
    this.usb_enabled = !!settings.usb;
    // (its USB disks' images: usb_disks[i] for mass_storage[i])
    if(settings.usb) settings.usb_disks = [];
    // the virt machine's virtio-blk disks (P5.4) and virtio-rng (P5.5)
    // (src/machine_options.js refuses them on the PC machines)
    if(options.virtio_disks) settings.virtio_disks = [];
    if(options.virtio_rng) settings.virtio_rng = true;
    // (their transport: virtio-mmio or the PCIe host, P5.7)
    if(options.virtio_transport) settings.virtio_transport = options.virtio_transport;
    // (virtio-input: a keyboard and a tablet, or the kinds listed, P5.8, P7.4)
    if(options.virtio_input) settings.virtio_input = Array.isArray(options.virtio_input) ? options.virtio_input.slice() : true;
    // (Android, P10.7: virtio-vsock, that many console ports, the GPU's PCI slot)
    if(options.virtio_vsock) settings.virtio_vsock = true;
    if(options.virtio_sound) settings.virtio_sound = true;
    if(options.virtio_console_ports) settings.virtio_console_ports = options.virtio_console_ports;
    if(options.virtio_gpu_pci_slot) settings.virtio_gpu_pci_slot = options.virtio_gpu_pci_slot;
    // (the ranchu machine: its framebuffer's size and density, its boot properties, src/virt/ranchu.js)
    if(options.ranchu_display) settings.ranchu_display = Object.assign({}, options.ranchu_display);
    if(options.ranchu_properties) settings.ranchu_properties = Object.assign({}, options.ranchu_properties);
    if(options.ranchu_gpu) settings.ranchu_gpu = options.ranchu_gpu;
    // (the GLES host's version: the options', an emulator image's (the bootloader's, below), else GLES 3.0; the ranchu
    // machine's option alone: another machine given it is refused, check_machine_options)
    if(settings.machine_type === "ranchu" || options.ranchu_gles_version !== undefined)
    {
        settings.ranchu_gles_version = options.ranchu_gles_version || DEFAULT_GLES_VERSION;
    }
    // (arm32's GLES backdoor: the GLES host's services for user code, src/arm/backdoor_a32.js)
    if(options.gles_backdoor) settings.gles_backdoor = true;

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
    const absolute_pointer = function(enabled)
    {
        if(enabled && !this.absolute_pointer_enabled &&
            typeof document !== "undefined" && document.pointerLockElement)
        {
            document.exitPointerLock();
        }
        this.absolute_pointer_enabled = enabled;
    };
    this.bus.register("vmware-absolute-mouse", absolute_pointer, this);
    // (the ARM machines' virtio tablet and touch screens: [active, the guest's cursor])
    this.bus.register("absolute-pointer", state => absolute_pointer.call(this, state[0]), this);

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
    // the network card's plugin (net_device.type "ne2k", the default, "e1000"), likewise
    const net_type = settings.net_device.type;
    const net_plugin = NET_DEVICE_PLUGINS.includes(net_type) ?
        load_device_plugin(NET_PLUGINS, net_type, settings.net_device.plugin_path, "net_device.plugin_path") : Promise.resolve(undefined);
    net_plugin.catch(() => {});
    // and the sound card's (audio_device "sb16", the default, "hd_audio")
    const audio_plugin = AUDIO_DEVICE_PLUGINS.includes(settings.audio_device) ?
        load_device_plugin(AUDIO_PLUGINS, settings.audio_device, options.audio_device_path, "audio_device_path") : Promise.resolve(undefined);
    audio_plugin.catch(() => {});
    // and USB's (usb: a controller and its devices)
    const usb_plugin = settings.usb ? load_device_plugin(USB_PLUGINS, "usb", settings.usb["plugin_path"], "usb.plugin_path") :
        Promise.resolve(undefined);
    usb_plugin.catch(() => {});
    // and the TPM's (tpm: docs/tpm.md); its module and its state are files (below)
    const tpm_plugin = settings.tpm ? load_device_plugin(TPM_PLUGINS, "tpm", settings.tpm["plugin_path"], "tpm.plugin_path") :
        Promise.resolve(undefined);
    tpm_plugin.catch(() => {});
    const adapter_renderer = this.create_adapter_renderer(options);

    // the disks' policies (src/disk_options.js), put on their buffers
    const disk_policies = new Map();
    /** @type {!Array<!Array<*>>} [name, buffer, descriptor] of the disks loaded */
    const loaded_disks = [];
    const disk_descriptors = new Map();

    // ugly, but required for closure compiler compilation
    function put_on_settings(name, buffer)
    {
        if(disk_policies.has(name))
        {
            set_disk_policy(buffer, name, disk_policies.get(name));
            loaded_disks.push([name, buffer, disk_descriptors.get(name)]);
        }

        // (virtio_disks[i]: "virtio_disk" + i)
        if(name.startsWith("virtio_disk"))
        {
            const i = +name.slice("virtio_disk".length);
            const disk = options.virtio_disks[i];
            settings.virtio_disks[i] = { buffer, id: disk.id, readonly: !!disk.readonly };
            return;
        }

        // (usb.mass_storage: "usb:" and the disk's id)
        if(name.startsWith("usb:"))
        {
            const disks = settings.usb.mass_storage;
            const i = disks.findIndex(disk => "usb:" + disk.id === name);
            settings.usb_disks[i] = { id: disks[i].id, buffer, read_only: !!disks[i].read_only };
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
            // android.vendor_ramdisk (docs/android-images-plan.md I2)
            case "android_vendor_ramdisk":
                settings.android_vendor_ramdisk = buffer.buffer;
                break;

            case "bios":
                settings.bios = buffer.buffer;
                break;
            case "vga_bios":
                settings.vga_bios = buffer.buffer;
                break;
            case "firmware_code":
                settings.firmware_code = buffer.buffer;
                break;
            case "firmware_vars":
                // (a buffer object: src/pflash.js writes into it)
                settings.firmware_vars = buffer;
                break;
            case "tpm_wasm":
                settings.tpm_wasm = buffer.buffer;
                break;
            case "tpm_state":
                // (a buffer object: src/tpm/store.js writes into it)
                settings.tpm_state = buffer;
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

        // (virtio_disks[i]: "virtio_disk" + i)
        if(disk_kind(name) !== "other")
        {
            disk_policies.set(name, check_disk_policy(name, file));
            disk_descriptors.set(name, file);
            // written back (docs/disk-persistence-plan.md): in Node, the
            // url's local file (src/disk_writeback.js); a buffer object of
            // one's own is its own backend
            if(disk_policies.get(name).disk_option === "read_write" && !(file.get && file.set && file.load))
            {
                files_to_load.push({ name, loadable: writeback_backend(name, file) });
                return;
            }
        }

        // hard disks in a container format (docs/disk-image-formats-plan.md);
        // without a format, RAW in the buffers of src/buffer.js
        if(check_image_options(name, file, name === "hda" || name === "hdb" || name.startsWith("virtio_disk") || name.startsWith("usb:")))
        {
            files_to_load.push({
                name,
                loadable: create_disk_image(name, file, this.disk_image_settings()),
            });
            return;
        }

        // (a RAW disk's logical sectors: set on its buffer once loaded)
        const sector_size = file["logical_sector_size"];

        if(file.get && file.set && file.load)
        {
            files_to_load.push({
                name: name,
                loadable: file,
                sector_size,
            });
            return;
        }

        if(name === "bios" || name === "vga_bios" || name === "firmware_code" || name === "firmware_vars" || name === "tpm_wasm" || name === "tpm_state" ||
            name === "initial_state" || name === "multiboot" ||
            name === "bzimage" || name === "initrd" || name === "kernel" || name === "dtb" || name === "android_vendor_ramdisk")
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
                sector_size,
            });
        }
        else
        {
            files_to_load.push({
                name,
                loadable: buffer_from_object(file, this.zstd_decompress_worker.bind(this)),
                sector_size,
            });
        }
    };

    if(options.state)
    {
        console.warn("Warning: Unknown option 'state'. Did you mean 'initial_state'?");
    }

    add_file("bios", options.bios);
    add_file("vga_bios", options.vga_bios);
    if(settings.firmware)
    {
        add_file("firmware_code", options.firmware.code);
        add_file("firmware_vars", options.firmware.vars);
    }
    if(settings.tpm)
    {
        // (beside the bundle unless wasm_path says; in Node a path)
        let wasm = settings.tpm["wasm_path"] || default_tpm_wasm_path();
        if(wasm.startsWith("file:")) wasm = decodeURIComponent(new URL(wasm).pathname);
        add_file("tpm_wasm", { url: wasm });
        add_file("tpm_state", settings.tpm["state"]);
    }
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
    add_file("android_vendor_ramdisk", options.android && options.android.vendor_ramdisk);
    // the virt machine's virtio-blk disks: {url or buffer, async, size, id,
    // readonly}; the buffer an ArrayBuffer, a File, or a buffer object of
    // its own (get, set, load), as hda may be
    (options.virtio_disks || []).forEach((disk, i) =>
    {
        const own = disk.buffer && disk.buffer.get && disk.buffer.set && disk.buffer.load;
        add_file("virtio_disk" + i, own ? disk.buffer : disk);
    });
    // USB disks (usb.mass_storage: { id, image, read_only }), the image as hda's
    if(settings.usb)
    {
        for(const disk of settings.usb.mass_storage || [])
        {
            const image = disk.image;
            const own = image.buffer && image.buffer.get && image.buffer.set && image.buffer.load;
            add_file("usb:" + disk.id, own ? image.buffer : image);
        }
    }

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

        // (a disk whose size is not a multiple of its sectors fails the start)
        const put = buffer =>
        {
            try
            {
                set_buffer_sector_size(f.name, buffer, f.sector_size);
            }
            catch(error)
            {
                reject_initialized(error);
                return;
            }
            put_on_settings.call(this, f.name, buffer);
            cont(index + 1);
        };

        if(f.loadable)
        {
            f.loadable.onload = function(e)
            {
                put(f.loadable);
            }.bind(this);
            // (a disk that cannot be opened fails the start: emulator-error)
            const loading = f.loadable.load();
            if(loading && typeof loading.catch === "function")
            {
                loading.catch(reject_initialized);
            }
        }
        else
        {
            load_whole_file(f.name, f.url, {
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
            }).then(result =>
            {
                if(f.url.endsWith(".zst") && f.name !== "initial_state")
                {
                    dbg_assert(f.size, "A size must be provided for compressed images");
                    result = this.zstd_decompress(f.size, new Uint8Array(/** @type {!ArrayBuffer} */ (result)));
                }

                put(f.as_json ? result : new SyncBuffer(result));
            }).catch(reject_initialized);
        }
    }.bind(this);
    // (a start that fails: the files written back opened so far are closed)
    initialized.catch(() =>
    {
        for(const f of files_to_load)
        {
            if(f.loadable && f.loadable.writeback && typeof f.loadable.close_now === "function") f.loadable.close_now();
        }
    });
    cont(0);
    return initialized;

    async function done()
    {
        // (a disk written back and another disk of the same file, by
        // another name: src/disk_writeback.js)
        await check_loaded_disks(loaded_disks);
        // (a floppy written back is used as it is: a floppy format's size)
        for(const [name, buffer] of loaded_disks)
        {
            if(disk_kind(String(name)) === "floppy" && buffer.writeback && !floppy_format_size(buffer.byteLength))
            {
                throw new Error(name + ": a floppy image written back must have the size of a floppy format (such as 1474560 bytes), not " +
                    buffer.byteLength);
            }
        }
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
        settings.net_device_plugin = await net_plugin;
        settings.audio_device_plugin = await audio_plugin;
        settings.usb_plugin = await usb_plugin;
        settings.tpm_plugin = await tpm_plugin;
        // (the TPM's module compiled and instantiated before the machine: asynchronous)
        if(settings.tpm_plugin) settings.tpm_prepared = await settings.tpm_plugin["prepare"]({ "wasm": settings.tpm_wasm });
        settings.graphics_adapter_renderer = await adapter_renderer;

        if(options.android)
        {
            // Android's bootloader (docs/android-images-plan.md I2): the
            // kernel, the initrd with bootconfig and the command line from
            // the first disk's boot partitions. Also with a state: a reset
            // loads them again (src/arm/cpu.js)
            const disk = settings.virtio_disks[0].buffer;
            const boot = await android_bootloader((offset, length) => new Promise(resolve => disk.get(offset, length, resolve)), disk.byteLength, {
                device: options.android.device, gpu_mode: options.android.gpu_mode, gles_version: options.ranchu_gles_version || options.android.gles_version,
                selinux: options.android.selinux,
                memory_mb: Math.round((settings.memory_size + (settings.extended_memory_size || 0)) / 1048576),
                vendor_ramdisk: settings.android_vendor_ramdisk ? new Uint8Array(settings.android_vendor_ramdisk) : undefined,
            });
            settings.kernel = boot.kernel.slice().buffer;
            settings.initrd = boot.initrd.slice().buffer;
            settings.cmdline = [boot.cmdline, options.cmdline].filter(Boolean).join(" ");
            // (an emulator image's device: its boot properties, under the options')
            if(boot.properties) settings.ranchu_properties = Object.assign({}, boot.properties, options.ranchu_properties);
            // (and its clock rate, with cooperative cores, unless the options set the clock)
            if(boot.clock_rate && !options.cpu_clock && !this.parallel_requested) settings.cpu_clock = { "rate": boot.clock_rate };
            // (and its GPU mode, which its command line follows)
            if(boot.ranchu_gpu) settings.ranchu_gpu = boot.ranchu_gpu;
            if(boot.gles_version) settings.ranchu_gles_version = boot.gles_version;
            if(boot.disks)
            {
                // (an emulator image: its disks the partitions, the first
                // written one keeping the disk's snapshot state)
                const owner = boot.disks.findIndex(d => !d.readonly);
                settings.virtio_disks = boot.disks.map((d, i) => ({ buffer: new PartitionBuffer(disk, d, i === owner), id: d.name, readonly: d.readonly }))
                    .concat(settings.virtio_disks.slice(1));
            }
            dbg_log("android: " + settings.kernel.byteLength + " bytes of kernel, " + settings.initrd.byteLength + " of initrd, " +
                (boot.vbmeta ? "vbmeta " + boot.vbmeta.digest : (boot.disks || []).map(d => d.name).join(", ")) + ", cmdline " + settings.cmdline);
        }

        // the GLES host's plugin (ranchu_gpu "host", gles_backdoor; docs/gles-proxy-plan.md):
        // the machine's GPU mode is known only now, after Android's bootloader
        if(settings.ranchu_gpu === "host" || settings.gles_backdoor)
        {
            settings.gles_plugin = await load_device_plugin(GLES_PLUGINS, "gles", options.ranchu_gpu_path, "ranchu_gpu_path");
            // (its GLSL ES compiler, glslang: GLSL ES 3.x's shaders; docs/gles3-plan.md)
            if(settings.gles_plugin["prepare"])
            {
                let glslang = null;
                try
                {
                    glslang = await load_whole_file("gles_glslang_path", options.gles_glslang_path || default_glslang_wasm_path());
                }
                catch(error)
                {
                    // (Node in the source tree, build/glslang.wasm not made: the repository's own)
                    const node = typeof process !== "undefined" && process.versions && process.versions.node;
                    if(node && !options.gles_glslang_path) glslang = await load_whole_file("gles_glslang_path", "bios/glslang.wasm").catch(() => null);
                    // (GLES 2.0's shaders need no glslang: without it, a GLES 3.x is the error)
                    if(!glslang && settings.ranchu_gles_version !== "2.0") throw error;
                    if(!glslang) console.warn(error.message + ": the GLES host offers GLES 2.0 alone");
                }
                if(glslang) settings.gles_prepared = await settings.gles_plugin["prepare"]({ "glslang": glslang });
            }
            // (no WebGPU, no renderer: say so rather than draw nothing)
            if(!settings.graphics_adapter_renderer)
            {
                throw new Error((settings.gles_backdoor ? "gles_backdoor" : "ranchu_gpu \"host\"") + ": the GLES host draws with the page's " +
                    "WebGPU renderer (libv86-webgpu.js and a WebGPU adapter), which this page does not have" +
                    (settings.gles_backdoor ? "" : "; use \"guest\" (the guest draws)"));
            }
        }

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
 * What the disk images (src/image/factory.js) need from the emulator
 * @return {!Object}
 */
V86.prototype.disk_image_settings = function()
{
    return {
        // a QCOW2 cluster or a downloaded image: an error for data that is
        // not a Zstandard frame of that size (the core returns no data)
        zstd_decompress: (size, bytes) =>
        {
            const cpu = this.v86.cpu;
            const context = cpu.zstd_create_ctx(bytes.length);
            try
            {
                new Uint8Array(cpu.wasm_memory.buffer).set(bytes, cpu.zstd_get_src_ptr(context) >>> 0);
                const pointer = cpu.zstd_read(context, size) >>> 0;
                if(!pointer) throw new Error("not a Zstandard frame of " + size + " bytes");
                const result = new Uint8Array(cpu.wasm_memory.buffer.slice(pointer, pointer + size));
                cpu.zstd_read_free(pointer, size);
                return result;
            }
            finally
            {
                cpu.zstd_free_ctx(context);
            }
        },
        zstd_decompress_worker: this.zstd_decompress_worker.bind(this),
        progress: (file_name, e) =>
        {
            this.emulator_bus.send("download-progress", {
                file_index: 0,
                file_count: 1,
                file_name,
                lengthComputable: e.lengthComputable,
                total: e.total,
                loaded: e.loaded,
            });
        },
    };
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
        // (stopped already: the disks written back are made durable all the same)
        await this.flush_writeback_disks();
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
    // the disks written back: their writes durable (docs/disk-persistence-plan.md)
    await this.flush_writeback_disks();
};

/**
 * [name, buffer] of the machine's disks
 * @return {!Array<!Array<*>>}
 */
V86.prototype.disk_buffers = function()
{
    if(!this.v86) return [];
    return disk_buffers(this.v86.cpu).map(([name, buffer]) => [name, buffer, undefined]);
};

/**
 * Flush (or, closing, flush and close) the disks written back
 * @param {boolean=} close
 * @return {!Promise<undefined>}
 */
V86.prototype.flush_writeback_disks = async function(close)
{
    const buffers = new Set(this.disk_buffers().map(([, buffer]) => buffer).filter(buffer => buffer.writeback));
    for(const buffer of buffers)
    {
        const operation = close ? buffer.close : buffer.flush;
        if(typeof operation !== "function") continue;
        await new Promise(resolve => operation.call(buffer, error =>
        {
            if(error) console.error((close ? "Closing " : "Flushing ") + (buffer.disk_name || "a disk") + ": " + error.message);
            resolve();
        }));
    }
};

/**
 * Free resources associated with this instance
 */
/** (pagehide: src/disk_service.js) */
V86.prototype.pagehide_disks = function()
{
    if(this.worker_controller)
    {
        this.worker_controller.rpc("pagehide").catch(() => {});
        return;
    }
    for(const [, buffer] of this.disk_buffers())
    {
        if(buffer.writeback && typeof buffer.close_keepalive === "function") buffer.close_keepalive();
    }
};

V86.prototype.destroy = async function()
{
    this.destroyed = true;
    if(this.pagehide_listener) window.removeEventListener("pagehide", this.pagehide_listener);
    if(this.worker_controller) await this.worker_controller.destroy();
    else await this.stop();
    if(this.device_state_operation) await this.device_state_operation;
    // (the disks written back: flushed, their files closed)
    if(!this.worker_controller) await this.flush_writeback_disks(true);

    for(const plugin of this.device_plugins)
    {
        plugin["destroy"] && await plugin["destroy"]();
    }
    this.adapter_renderer && this.adapter_renderer["destroy"]();
    this.gles_compositor && this.gles_compositor["destroy"]();
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
        await this.prepare_host_state();
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
        await this.prepare_host_state();
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
 * Whether the display adapter, or the ranchu machine's GLES host, keeps
 * state on the GPU that a snapshot fetches
 * @return {boolean}
 */
V86.prototype.adapter_host_state = function()
{
    const devices = this.v86 && this.v86.cpu.devices;
    const adapter = devices && devices.graphics_adapter;
    return !!adapter && adapter.has_host_state() || !!(devices && devices.gles);
};

/**
 * Before a save: the GPU's state the display adapter and the GLES host
 * keep fetched (their prepare_save)
 * @return {!Promise<undefined>}
 */
V86.prototype.prepare_host_state = async function()
{
    if(!this.adapter_host_state()) return;
    const devices = this.v86.cpu.devices;
    const adapter = devices.graphics_adapter;
    if(adapter && adapter.has_host_state()) await adapter.prepare_save();
    const prepare = devices.gles && devices.gles.device["prepare_save"];
    if(prepare) await prepare();
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
        const cpu = this.v86.cpu;
        // (the ARM core counts the instructions each core retired, P0.9)
        if(is_arm(cpu.cpu_type))
        {
            let retired = 0;
            for(let core = 0; core < cpu.cores; core++) retired += cpu.retired_instructions(core);
            return retired >>> 0;
        }
        return cpu.instruction_counter[0] >>> 0;
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
 * when physically changing the floppy disk. With disk_option "read_write"
 * (docs/disk-persistence-plan.md) the guest's writes go back to the image;
 * the disk taken out (another inserted, or ejected) is flushed and closed.
 */
V86.prototype.set_fda = async function(file)
{
    if(this.worker_controller) return this.worker_controller.rpc("set_fda", [encode_worker_file(file)]);
    await this.insert_floppy(0, file);
};

/**
 * Set the image inserted in the second floppy drive, also at runtime.
 */
V86.prototype.set_fdb = async function(file)
{
    if(this.worker_controller) return this.worker_controller.rpc("set_fdb", [encode_worker_file(file)]);
    await this.insert_floppy(1, file);
};

/**
 * @param {number} index
 * @param {!Object} file
 */
V86.prototype.insert_floppy = async function(index, file)
{
    const name = index ? "fdb" : "fda";
    file = /** @type {!Object} */ (await opfs_readable(name, file));
    check_image_options(name, file, false);
    const policy = check_disk_policy(name, file);
    const others = this.disk_descriptors.filter(([n]) => n !== name);
    check_disk_bindings([[name, file, policy]], others);
    const drive = this.v86.cpu.devices.fdc.drives[index];
    let image;
    if(policy.disk_option === "read_write" && !(file.get && file.set && file.load))
    {
        image = writeback_backend(name, file);
        await image.load();
        if(!floppy_format_size(image.byteLength))
        {
            image.close_now();
            throw new Error(name + ": a floppy image written back must have the size of a floppy format (such as 1474560 bytes), not " + image.byteLength);
        }
    }
    else if(file.url && !file.async)
    {
        image = new SyncBuffer(await load_whole_file(name, file.url));
    }
    else
    {
        image = buffer_from_object(file, this.zstd_decompress_worker.bind(this));
        await new Promise((resolve, reject) => { image.onload = resolve; Promise.resolve(image.load()).catch(reject); });
    }
    set_disk_policy(image, name, policy);
    this.close_floppy(drive);
    drive.insert_disk(image);
    this.disk_descriptors = others.concat([[name, file]]);
};

/**
 * The disk taken out of a floppy drive: written back, it is flushed and closed
 * @param {?} drive
 */
V86.prototype.close_floppy = function(drive)
{
    this.v86.cpu.devices.fdc.disk_removed(drive);
    const buffer = drive.buffer;
    if(buffer && buffer.writeback && typeof buffer.close === "function")
    {
        buffer.close(error => { if(error) console.error(error.message); });
    }
};

/**
 * Eject floppy drive fda.
 */
V86.prototype.eject_fda = function()
{
    if(this.worker_controller) return this.worker_controller.rpc("eject_fda");
    const drive = this.v86.cpu.devices.fdc.drives[0];
    this.close_floppy(drive);
    drive.eject_disk();
    this.disk_descriptors = this.disk_descriptors.filter(([n]) => n !== "fda");
};

/**
 * Eject second floppy drive fdb.
 */
V86.prototype.eject_fdb = function()
{
    if(this.worker_controller) return this.worker_controller.rpc("eject_fdb");
    const drive = this.v86.cpu.devices.fdc.drives[1];
    this.close_floppy(drive);
    drive.eject_disk();
    this.disk_descriptors = this.disk_descriptors.filter(([n]) => n !== "fdb");
};

/**
 * Read an OVF package, an OVA archive (docs/disk-image-formats-plan.md P4),
 * before a machine is made: its disks as descriptors for hda, hdb or
 * attach_sata_drive (the archive with archive_member: read in it, not
 * extracted), the hardware it describes as v86 options (memory_size,
 * cpu_cores, machine_type, hda, hdb), and notes for what v86 does not have
 * (architecture, firmware, controllers, devices).
 * @param {!Object} file the archive, as for hda (url, buffer)
 * @return {!Promise<!Object>} {ovf, files, disks, options, notes}
 */
V86.import_ova = function(file)
{
    return import_ova(file, {});
};

/**
 * The buffer of a hard disk or CD drive by its name (hda, hdb, cdrom,
 * sata<port>)
 * @param {string} name
 * @return {?}
 */
V86.prototype.disk_buffer = function(name)
{
    const entry = this.v86.cpu.disk_devices().find(([device_name]) => device_name === name);
    const buffer = entry && entry[1].buffer;
    if(!buffer) throw new Error("No disk " + name);
    return buffer;
};

/**
 * What an export of a disk writes (export_disk_image): its size as the guest
 * sees it, and its image's format, file size and the bytes the guest wrote;
 * the guest's sector size
 * @param {string} name hda, hdb, cdrom, sata<port>, (virt) virtio_disk<n>
 * @return {!Promise<!Object>}
 */
V86.prototype.disk_image_info = async function(name)
{
    if(this.worker_controller) return this.worker_controller.rpc("disk-info", [name]);
    const buffer = this.disk_buffer(name);
    const reader = buffer.reader;
    const device = this.v86.cpu.disk_devices().find(([device_name]) => device_name === name)[1];
    return {
        "name": name,
        "format": reader ? reader.format : "raw",
        "size": buffer.byteLength,
        "file_size": reader ? reader.source.byteLength : buffer.byteLength,
        "written": buffer.overlay ? buffer.overlay.size() : buffer.written_blocks ? buffer.written_blocks.size * 256 : undefined,
        // (an IDE or AHCI drive's, a CD's 2048; a virtio disk's image's)
        "logical_sector_size": device.sector_size || buffer.logical_sector_size || 512,
    };
};

/**
 * Export a disk as the guest sees it, as a RAW image of its whole size
 * (docs/disk-image-formats-plan.md P2) or as a new QCOW2 image (format:
 * "qcow2", P5: version 3, 64 KiB clusters, the clusters of zeros left out):
 * the image's data with the guest's writes. The machine stops and its disk
 * I/O finishes first, so the stream is one view of the disk; it goes on
 * afterwards. `write` gets each chunk (at most 1 MiB) and may return a
 * promise: the next chunk waits for it.
 * @param {string} name hda, hdb, cdrom, sata<port>, (virt) virtio_disk<n>
 * @param {{write: function(!Uint8Array):(Promise<*>|undefined),
 *          format: (string|undefined),
 *          progress: (function({loaded: number, total: number})|undefined),
 *          signal: (AbortSignal|undefined)}} options
 * @return {!Promise<number>} the size written
 */
V86.prototype.export_disk_image = async function(name, options)
{
    if(!options || typeof options.write !== "function") throw new TypeError("export_disk_image: options.write must be a function");
    if(this.worker_controller) return this.worker_controller.export_disk(name, options);
    const buffer = this.disk_buffer(name);
    // (a disk written back: flushed, then read from its image)
    if(buffer.writeback && typeof buffer.flush === "function") await new Promise(resolve => buffer.flush(resolve));
    return this.v86.export_disk(buffer, options.write, options);
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
 * A CD of files into the CD-ROM drive: an ISO 9660 image made of them, the
 * files in its root directory
 * @param {Array<{name: string, contents: Uint8Array}>} files
 */
V86.prototype.set_cdrom_files = async function(files)
{
    await this.set_cdrom({ buffer: iso9660.generate(files).buffer });
};

/**
 * Watch the first network card's traffic: each packet the guest sends
 * ("O") and receives ("I"), as it passes
 * @param {function(string, Uint8Array)} listener
 * @return {function()} stops watching
 */
V86.prototype.capture_network_traffic = function(listener)
{
    const received = data => listener("I", data);
    const sent = data => listener("O", data);
    this.emulator_bus.register("net0-receive", received, this);
    this.bus.register("net0-send", sent, this);
    return () =>
    {
        this.emulator_bus.unregister("net0-receive", received);
        this.bus.unregister("net0-send", sent);
    };
};

/**
 * The speaker's volume: 0 mutes it, 1 is full
 * @param {number} volume
 * @return {boolean} whether the machine has a speaker (none with disable_speaker)
 */
V86.prototype.set_speaker_volume = function(volume)
{
    if(!this.speaker_adapter) return false;
    this.speaker_adapter.mixer.set_volume(volume, undefined);
    return true;
};

/**
 * The CD-ROM drive: whether the machine has one (an IDE or AHCI drive; the
 * virt machine's CD image is a virtio disk) and whether a disc is in it
 * @return {!Promise<{present: boolean, inserted: boolean}>}
 */
V86.prototype.get_cdrom_state = async function()
{
    if(this.worker_controller) return this.worker_controller.rpc("get_cdrom_state");
    const devices = this.v86.cpu.devices;
    const cdrom = devices && devices.cdrom;
    return { "present": !!cdrom, "inserted": !!cdrom && cdrom.has_disk() };
};

/**
 * Set the image inserted in the CD-ROM drive. Can be changed at runtime, as
 * when physically changing the CD-ROM.
 */
V86.prototype.set_cdrom = async function(file)
{
    if(this.worker_controller) return this.worker_controller.rpc("set_cdrom", [encode_worker_file(file)]);
    file = await opfs_readable("cdrom", file);
    check_image_options("cdrom", file, false);
    if(file.url && !file.async)
    {
        this.v86.cpu.devices.cdrom.set_cdrom(new SyncBuffer(await load_whole_file("cdrom", file.url)));
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
    const name = cdrom ? "cdrom" : "sata" + port;
    const image = await this.load_attached_disk(name, file, cdrom, "attach_sata_drive");
    try { ahci.attach(port, { buffer: image, is_cdrom: cdrom }); }
    catch(error)
    {
        this.disk_descriptors = this.disk_descriptors.filter(([disk_name]) => disk_name !== name);
        throw error;
    }
};

/**
 * The image of a drive attached to the running machine (a SATA drive, a USB
 * disk), loaded as the disk options' are: written back by its disk_option,
 * a disk image's container, a whole file, or a buffer; its policy on it
 * (docs/disk-persistence-plan.md: checked with the disks the machine has)
 * @param {string} name the disk's name (its policy, errors, sector size)
 * @param {Object|null} file the image, as for the hda option (null: an empty CD drive)
 * @param {boolean} cdrom
 * @param {string} caller
 * @return {!Promise<?Object>}
 */
V86.prototype.load_attached_disk = async function(name, file, cdrom, caller)
{
    file = await opfs_readable(name, file);
    const policy = check_disk_policy(name, file);
    if(file) check_disk_bindings([[name, file, policy]], this.disk_descriptors);
    let image;
    const writeback = policy.disk_option === "read_write" && !(file.get && file.set && file.load);
    const disk_image = !writeback && !!check_image_options(name, file, !cdrom);
    if(writeback)
    {
        // (written back: src/disk_writeback.js, src/disk_service.js)
        image = writeback_backend(name, /** @type {!Object} */ (file));
        await image.load();
        try { await check_loaded_disks([[name, image, file]].concat(this.disk_buffers())); }
        catch(error) { image.close_now(); throw error; }
    }
    else if(disk_image)
    {
        // a hard disk in a container format (docs/disk-image-formats-plan.md)
        image = create_disk_image(name, /** @type {!Object} */ (file), this.disk_image_settings());
        await image.load();
    }
    else if(file && file.url && !file.async)
    {
        image = new SyncBuffer(await load_whole_file(name, file.url));
    }
    else if(file)
    {
        // (a descriptor as for the hda option, or a buffer object of one's own)
        image = await new Promise((resolve, reject) => {
            const buffer = file.get && file.set && file.load ? file : buffer_from_object(file, this.zstd_decompress_worker.bind(this));
            if(!buffer) throw new Error(caller + ": not a disk image");
            buffer.onload = () => resolve(buffer);
            Promise.resolve(buffer.load()).catch(reject);
        });
    }
    if(image && !cdrom)
    {
        // (a RAW disk's logical sectors; a disk image has its own)
        if(!disk_image) set_buffer_sector_size(name, image, file["logical_sector_size"]);
        // (an ATA disk's CHS geometry comes from its partition table)
        if(typeof image.get_and_cache === "function") await new Promise(resolve => image.get_and_cache(0, 512, resolve));
    }
    set_disk_policy(image, name, policy);
    if(file) this.disk_descriptors.push([name, file]);
    return image;
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
    const device = ahci.ports[port] && ahci.ports[port].device;
    ahci.detach(port);
    // (a disk written back: its writes flushed, the file closed)
    if(device && device.buffer && device.buffer.writeback && typeof device.buffer.close === "function")
    {
        device.buffer.close(error => { if(error) console.error(error.message); });
    }
    const names = ["sata" + port, ["hda", "hdb", "cdrom"][port]];
    this.disk_descriptors = this.disk_descriptors.filter(([name]) => !names.includes(name));
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
 * Plug a USB device out of its port or back in (usb's devices: "tablet"):
 * the guest sees it leave or arrive, as at a socket. Fulfilled once done;
 * rejected for a device the machine does not have.
 * @param {string} id
 * @param {boolean} plugged
 * @return {!Promise<void>}
 */
V86.prototype.usb_plug = function(id, plugged)
{
    if(!this.usb_enabled) return Promise.reject(new Error("usb_plug: the machine has no USB (the usb option)"));
    return new Promise((resolve, reject) =>
    {
        const listener = data =>
        {
            if(data[0] !== id) return;
            this.remove_listener("usb-plugged", listener);
            if(data[2]) reject(new Error("usb_plug: " + data[2]));
            else resolve();
        };
        this.add_listener("usb-plugged", listener);
        this.bus.send("usb-plug", [id, !!plugged]);
    });
};

/**
 * The USB devices: each one's id, port, whether it is in its port, the
 * controller that has it ("xhci", "ehci", or "uhci": the UHCI or an EHCI's
 * companion) and its speed in Mbit/s (12, 480, 5000)
 * @return {!Promise<!Array<{id: string, port: number, plugged: boolean, controller: string, speed: number}>>}
 */
V86.prototype.usb_devices = async function()
{
    if(this.worker_controller) return this.worker_controller.rpc("usb_devices");
    const usb = this.v86 && this.v86.cpu.devices.usb;
    return usb ? usb.device["device_list"]() : [];
};

/**
 * Plug a disk image into the machine as a USB disk (a USB stick: usb's
 * mass storage, in the first free port of the USB controller). The guest
 * sees it arrive and mounts it. The image is as for the hda option, with
 * disk_option and disk_error; read_only: the guest sees it write protected.
 *
 * A snapshot holds the USB disks in their ports: to restore one taken with
 * a USB disk, attach the same image with the same id first; otherwise the
 * restored guest sees the disk leave.
 *
 * @param {string} id the disk's id (usb_plug, usb_detach_disk, "usb:" + id is its name for disk_buffer)
 * @param {!Object} file
 * @param {{read_only: (boolean|undefined)}=} options
 * @return {!Promise<void>}
 */
V86.prototype.usb_attach_disk = async function(id, file, options)
{
    const read_only = !!(options && options.read_only);
    if(this.worker_controller) return this.worker_controller.rpc("usb_attach_disk", [id, encode_worker_file(file), { "read_only": read_only }]);
    const usb = this.v86.cpu.devices.usb;
    if(!usb) throw new Error("usb_attach_disk: the machine has no USB (the usb option)");
    if(typeof id !== "string" || !id || id === "tablet") throw new Error("usb_attach_disk: a USB disk needs an id of its own");
    if(!file) throw new Error("usb_attach_disk: a USB disk needs an image");
    const name = "usb:" + id;
    const image = await this.load_attached_disk(name, file, false, "usb_attach_disk");
    try { this.v86.cpu.usb_attach_disk(id, image, read_only); }
    catch(error)
    {
        this.disk_descriptors = this.disk_descriptors.filter(([disk_name]) => disk_name !== name);
        throw error;
    }
};

/**
 * Pull a USB disk out (a surprise removal, as when pulling a USB stick
 * out): writes the guest issued before are in the image; a disk written
 * back is flushed and closed. (To let the guest finish first, eject it in
 * the guest; the "usb-disk-ejected" event tells when the guest ejected it.)
 * @param {string} id
 * @return {!Promise<void>}
 */
V86.prototype.usb_detach_disk = async function(id)
{
    if(this.worker_controller) return this.worker_controller.rpc("usb_detach_disk", [id]);
    const buffer = this.v86.cpu.usb_detach_disk(id);
    if(buffer && buffer.writeback && typeof buffer.close === "function")
    {
        await new Promise(resolve => buffer.close(error => { if(error) console.error(error.message); resolve(); }));
    }
    this.disk_descriptors = this.disk_descriptors.filter(([name]) => name !== "usb:" + id);
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
 * Send text (as UTF-8) or bytes to the guest's first virtio console port
 * (hvc0 on the virt machine, the kernel's console there)
 * @param {string|Uint8Array} data
 */
V86.prototype.virtio_console_send = function(data)
{
    this.bus.send("virtio-console0-input-bytes", typeof data === "string" ? new TextEncoder().encode(data) : data);
};

/**
 * A stream socket to a port of the guest's vsock (machine_type "virt" with
 * virtio_vsock; src/virtio_vsock.js): resolves when the guest accepts,
 * rejects when it refuses. The stream has write(bytes), close(), and the
 * callbacks on_data(bytes) and on_close() to be set.
 *
 * @param {number} port
 * @return {!Promise<!Object>}
 */
V86.prototype.vsock_connect = function(port)
{
    const id = this.vsock_next_id = (this.vsock_next_id || 0) + 1;
    const stream = {
        "closed": false,
        "on_data": null,
        "on_close": null,
        "write": bytes => { if(!stream["closed"]) this.bus.send("virtio-vsock-send", [id, bytes]); },
        "close": () => { if(!stream["closed"]) this.bus.send("virtio-vsock-close", [id]); },
    };
    return new Promise((resolve, reject) => {
        let connected = false;
        const on_connected = ([i]) => { if(i === id) { connected = true; resolve(stream); } };
        const on_data = ([i, bytes]) => { if(i === id && stream["on_data"]) stream["on_data"](bytes); };
        const on_closed = ([i]) => {
            if(i !== id) return;
            stream["closed"] = true;
            this.bus.unregister("virtio-vsock-connected", on_connected);
            this.bus.unregister("virtio-vsock-data", on_data);
            this.bus.unregister("virtio-vsock-closed", on_closed);
            if(!connected) reject(new Error("vsock: the guest refused port " + port));
            else if(stream["on_close"]) stream["on_close"]();
        };
        this.bus.register("virtio-vsock-connected", on_connected, this);
        this.bus.register("virtio-vsock-data", on_data, this);
        this.bus.register("virtio-vsock-closed", on_closed, this);
        this.bus.send("virtio-vsock-connect", [id, port]);
    });
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

    // Read the whole screen every 100 ms, not only after an event that says it
    // changed: no event may follow the last change (the screen of a CPU in a
    // worker comes in batches of its own), and a mode set resizes the text
    // screen through transient sizes (80x256 while the VGA BIOS programs the
    // CRTC), so rows that changed earlier may no longer exist
    let succeeded = screen_contains_expected();
    const end = timeout_msec ? performance.now() + timeout_msec : 0;
    while(!succeeded && (!end || performance.now() < end))
    {
        await new Promise(resolve => setTimeout(resolve, 100));
        succeeded = screen_contains_expected();
    }
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
    const limit = is_arm(this.cpu_type) ? 0x10000000000 : 0x1000000000;
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
V86.prototype["export_disk_image"] = V86.prototype.export_disk_image;
V86.prototype["disk_image_info"] = V86.prototype.disk_image_info;
V86["import_ova"] = V86.import_ova;
V86.prototype["restore_state_stream"] = V86.prototype.restore_state_stream;
V86.prototype["vsock_connect"] = V86.prototype.vsock_connect;
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
