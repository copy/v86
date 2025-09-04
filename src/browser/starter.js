import { v86 } from "../main.js";
import { LOG_CPU, WASM_TABLE_OFFSET, WASM_TABLE_SIZE } from "../const.js";
import { get_rand_int, load_file, read_sized_string_from_mem } from "../lib.js";
import { dbg_assert, dbg_trace, dbg_log, set_log_level } from "../log.js";
import * as print_stats from "./print_stats.js";
import { Bus } from "../bus.js";
import { BOOT_ORDER_FD_FIRST, BOOT_ORDER_HD_FIRST, BOOT_ORDER_CD_FIRST } from "../rtc.js";
import { EEXIST, ENOENT } from "../../lib/9p.js";

import { SpeakerAdapter } from "./speaker.js";
import { NetworkAdapter } from "./network.js";
import { FetchNetworkAdapter } from "./fetch_network.js";
import { WispNetworkAdapter } from "./wisp_network.js";
import { KeyboardAdapter } from "./keyboard.js";
import { MouseAdapter } from "./mouse.js";
import { ScreenAdapter } from "./screen.js";
import { DummyScreenAdapter } from "./dummy_screen.js";
import { SerialAdapter, SerialAdapterXtermJS } from "./serial.js";
import { InBrowserNetworkAdapter } from "./inbrowser_network.js";

import { MemoryFileStorage, ServerFileStorageWrapper } from "./filestorage.js";
import { SyncBuffer, buffer_from_object } from "../buffer.js";
import { FS } from "../../lib/filesystem.js";

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

    //var worker = new Worker("src/browser/worker.js");
    //var adapter_bus = this.bus = WorkerBus.init(worker);

    this.cpu_is_running = false;
    this.cpu_exception_hook = function(n) {};

    const bus = Bus.create();
    this.bus = bus[0];
    this.emulator_bus = bus[1];

    var cpu;
    var wasm_memory;

    const wasm_table = new WebAssembly.Table({ element: "anyfunc", initial: WASM_TABLE_SIZE + WASM_TABLE_OFFSET });

    const wasm_shared_funcs = {
        "cpu_exception_hook": n => this.cpu_exception_hook(n),
        "run_hardware_timers": function(a, t) { return cpu.run_hardware_timers(a, t); },
        "cpu_event_halt": () => { this.emulator_bus.send("cpu-event-halt"); },
        "abort": function() { dbg_assert(false); },
        "microtick": v86.microtick,
        "get_rand_int": function() { return get_rand_int(); },
        "stop_idling": function() { return cpu.stop_idling(); },

        "io_port_read8": function(addr) { return cpu.io.port_read8(addr); },
        "io_port_read16": function(addr) { return cpu.io.port_read16(addr); },
        "io_port_read32": function(addr) { return cpu.io.port_read32(addr); },
        "io_port_write8": function(addr, value) { cpu.io.port_write8(addr, value); },
        "io_port_write16": function(addr, value) { cpu.io.port_write16(addr, value); },
        "io_port_write32": function(addr, value) { cpu.io.port_write32(addr, value); },

        "mmap_read8": function(addr) { return cpu.mmap_read8(addr); },
        "mmap_read16": function(addr) { return cpu.mmap_read16(addr); },
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

        "codegen_finalize": (wasm_table_index, start, state_flags, ptr, len) => {
            cpu.codegen_finalize(wasm_table_index, start, state_flags, ptr, len);
        },
        "jit_clear_func": (wasm_table_index) => cpu.jit_clear_func(wasm_table_index),
        "jit_clear_all_funcs": () => cpu.jit_clear_all_funcs(),

        "__indirect_function_table": wasm_table,
    };

    let wasm_fn = options.wasm_fn;

    if(!wasm_fn)
    {
        wasm_fn = env =>
        {
            /* global __dirname */

            return new Promise(resolve => {
                let v86_bin = DEBUG ? "v86-debug.wasm" : "v86.wasm";
                let v86_bin_fallback = "v86-fallback.wasm";

                if(options.wasm_path)
                {
                    v86_bin = options.wasm_path;
                    v86_bin_fallback = v86_bin.replace("v86.wasm", "v86-fallback.wasm");
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

                load_file(v86_bin, {
                    done: async bytes =>
                    {
                        try
                        {
                            const { instance } = await WebAssembly.instantiate(bytes, env);
                            this.wasm_source = bytes;
                            resolve(instance.exports);
                        }
                        catch(err)
                        {
                            load_file(v86_bin_fallback, {
                                    done: async bytes => {
                                        const { instance } = await WebAssembly.instantiate(bytes, env);
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

    wasm_fn({ "env": wasm_shared_funcs })
        .then((exports) => {
            wasm_memory = exports.memory;
            exports["rust_init"]();

            const emulator = this.v86 = new v86(this.emulator_bus, { exports, wasm_table });
            cpu = emulator.cpu;

            this.continue_init(emulator, options);
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

    this.disk_images = {
        fda: undefined,
        fdb: undefined,
        hda: undefined,
        hdb: undefined,
        cdrom: undefined,
    };

    const boot_order =
        options.boot_order ? options.boot_order :
        options.fda ? BOOT_ORDER_FD_FIRST :
        options.hda ? BOOT_ORDER_HD_FIRST : BOOT_ORDER_CD_FIRST;

    settings.acpi = options.acpi;
    settings.disable_jit = options.disable_jit;
    settings.load_devices = true;
    settings.memory_size = options.memory_size || 64 * 1024 * 1024;
    settings.vga_memory_size = options.vga_memory_size || 8 * 1024 * 1024;
    settings.boot_order = boot_order;
    settings.fastboot = options.fastboot || false;
    settings.fda = undefined;
    settings.fdb = undefined;
    settings.uart1 = options.uart1;
    settings.uart2 = options.uart2;
    settings.uart3 = options.uart3;
    settings.cmdline = options.cmdline;
    settings.preserve_mac_from_state_image = options.preserve_mac_from_state_image;
    settings.mac_address_translation = options.mac_address_translation;
    settings.cpuid_level = options.cpuid_level;
    settings.virtio_balloon = options.virtio_balloon;
    settings.virtio_console = options.virtio_console;

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
    settings.net_device = options.net_device || { type: "ne2k" };

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

    if(screen_options.container)
    {
        this.screen_adapter = new ScreenAdapter(screen_options, () => this.v86.cpu.devices.vga && this.v86.cpu.devices.vga.screen_fill_buffer());
    }
    else
    {
        this.screen_adapter = new DummyScreenAdapter(screen_options);
    }
    settings.screen = this.screen_adapter;
    settings.screen_options = screen_options;

    if(options.serial_container)
    {
        this.serial_adapter = new SerialAdapter(options.serial_container, this.bus);
        //this.recording_adapter = new SerialRecordingAdapter(this.bus);
    }

    if(options.serial_container_xtermjs)
    {
        this.serial_adapter = new SerialAdapterXtermJS(options.serial_container_xtermjs, this.bus);
    }

    if(!options.disable_speaker)
    {
        this.speaker_adapter = new SpeakerAdapter(this.bus);
    }

    // ugly, but required for closure compiler compilation
    function put_on_settings(name, buffer)
    {
        switch(name)
        {
            case "hda":
                settings.hda = this.disk_images.hda = buffer;
                break;
            case "hdb":
                settings.hdb = this.disk_images.hdb = buffer;
                break;
            case "cdrom":
                settings.cdrom = this.disk_images.cdrom = buffer;
                break;
            case "fda":
                settings.fda = this.disk_images.fda = buffer;
                break;
            case "fdb":
                settings.fdb = this.disk_images.fdb = buffer;
                break;

            case "multiboot":
                settings.multiboot = this.disk_images.multiboot = buffer.buffer;
                break;
            case "bzimage":
                settings.bzimage = this.disk_images.bzimage = buffer.buffer;
                break;
            case "initrd":
                settings.initrd = this.disk_images.initrd = buffer.buffer;
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
            name === "bzimage" || name === "initrd")
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
            file_storage = new ServerFileStorageWrapper(file_storage, base_url);
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

    var cont = function(index)
    {
        if(index === total)
        {
            setTimeout(done.bind(this), 0);
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

        this.v86.init(settings);

        if(settings.initial_state)
        {
            emulator.restore_state(settings.initial_state);

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

            globalThis.onmessage = function(e)
            {
                if(!wasm)
                {
                    const env = Object.fromEntries([
                        "cpu_exception_hook", "run_hardware_timers",
                        "cpu_event_halt", "microtick", "get_rand_int", "stop_idling",
                        "io_port_read8", "io_port_read16", "io_port_read32",
                        "io_port_write8", "io_port_write16", "io_port_write32",
                        "mmap_read8", "mmap_read16", "mmap_read32",
                        "mmap_write8", "mmap_write16", "mmap_write32", "mmap_write64", "mmap_write128",
                        "codegen_finalize",
                        "jit_clear_func", "jit_clear_all_funcs",
                    ].map(f => [f, () => console.error("zstd worker unexpectedly called " + f)]));

                    env["__indirect_function_table"] = new WebAssembly.Table({ element: "anyfunc", initial: 1024 });
                    env["abort"] = () => { throw new Error("zstd worker aborted"); };
                    env["log_from_wasm"] = env["console_log_from_wasm"] = (off, len) => {
                        console.log(read_sized_string_from_mem(wasm.exports.memory.buffer, off, len));
                    };
                    env["dbg_trace_from_wasm"] = () => console.trace();

                    wasm = new WebAssembly.Instance(new WebAssembly.Module(e.data), { "env": env });
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
    this.v86.run();
};

/**
 * Stop emulation. Do nothing if emulator is not running. Can be asynchronous.
 */
V86.prototype.stop = async function()
{
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
};

/**
 * Free resources associated with this instance
 */
V86.prototype.destroy = async function()
{
    await this.stop();

    this.v86.destroy();
    this.keyboard_adapter && this.keyboard_adapter.destroy();
    this.network_adapter && this.network_adapter.destroy();
    this.mouse_adapter && this.mouse_adapter.destroy();
    this.screen_adapter && this.screen_adapter.destroy();
    this.serial_adapter && this.serial_adapter.destroy();
    this.speaker_adapter && this.speaker_adapter.destroy();
};

/**
 * Restart (force a reboot).
 */
V86.prototype.restart = function()
{
    this.v86.restart();
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
    dbg_assert(arguments.length === 1);
    this.v86.restore_state(state);
};

/**
 * Asynchronously save the current state of the emulator.
 *
 * @return {Promise<ArrayBuffer>}
 */
V86.prototype.save_state = async function()
{
    dbg_assert(arguments.length === 0);
    return this.v86.save_state();
};

/**
 * @return {number}
 * @ignore
 */
V86.prototype.get_instruction_counter = function()
{
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
    this.v86.cpu.devices.fdc.drives[0].eject_disk();
};

/**
 * Eject second floppy drive fdb.
 */
V86.prototype.eject_fdb = function()
{
    this.v86.cpu.devices.fdc.drives[1].eject_disk();
};

/**
 * Return buffer object of floppy disk of drive fda or null if the drive is empty.
 * @return {Uint8Array|null}
 */
V86.prototype.get_disk_fda = function()
{
    return this.v86.cpu.devices.fdc.drives[0].get_buffer();
};

/**
 * Return buffer object of second floppy disk of drive fdb or null if the drive is empty.
 * @return {Uint8Array|null}
 */
V86.prototype.get_disk_fdb = function()
{
    return this.v86.cpu.devices.fdc.drives[1].get_buffer();
};

/**
 * Set the image inserted in the CD-ROM drive. Can be changed at runtime, as
 * when physically changing the CD-ROM.
 */
V86.prototype.set_cdrom = async function(file)
{
    if(file.url && !file.async)
    {
        load_file(file.url, {
            done: result =>
            {
                this.v86.cpu.devices.cdrom.set_cdrom(new SyncBuffer(result));
            },
        });
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
    this.v86.cpu.devices.cdrom.eject();
};

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
 * Go fullscreen (only browsers)
 */
V86.prototype.screen_go_fullscreen = function()
{
    if(!this.screen_adapter)
    {
        return;
    }

    var elem = document.getElementById("screen_container");

    if(!elem)
    {
        return;
    }

    // bracket notation because otherwise they get renamed by closure compiler
    var fn = elem["requestFullScreen"] ||
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
 * Set the modem status of a serial port.
 */
V86.prototype.serial_set_modem_status = function(serial, status)
{
    this.bus.send("serial" + serial + "-modem-status-input", status);
};

/**
 * Set the carrier detect status of a serial port.
 */
V86.prototype.serial_set_carrier_detect = function(serial, status)
{
    this.bus.send("serial" + serial + "-carrier-detect-input", status);
};

/**
 * Set the ring indicator status of a serial port.
 */
V86.prototype.serial_set_ring_indicator = function(serial, status)
{
    this.bus.send("serial" + serial + "-ring-indicator-input", status);
};

/**
 * Set the data set ready status of a serial port.
 */
V86.prototype.serial_set_data_set_ready = function(serial, status)
{
    this.bus.send("serial" + serial + "-data-set-ready-input", status);
};

/**
 * Set the clear to send status of a serial port.
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
    const match_multi = Array.isArray(expected);
    const timeout_msec = options?.timeout_msec || 0;
    const changed_rows = new Set();
    const screen_put_char = args => changed_rows.add(args[0]);
    const contains_expected = (screen_line, pattern) => pattern.test ? pattern.test(screen_line) : screen_line.startsWith(pattern);
    const screen_lines = [];

    this.add_listener("screen-put-char", screen_put_char);

    for(const screen_line of this.screen_adapter.get_text_screen())
    {
        if(match_multi)
        {
            screen_lines.push(screen_line.trimRight());
        }
        else if(contains_expected(screen_line, expected))
        {
            this.remove_listener("screen-put-char", screen_put_char);
            return true;
        }
    }

    let succeeded = false;
    const end = timeout_msec ? performance.now() + timeout_msec : 0;
    loop: while(!end || performance.now() < end)
    {
        if(match_multi)
        {
            let screen_height = screen_lines.length;
            while(screen_height > 0 && screen_lines[screen_height - 1] === "")
            {
                screen_height--;
            }
            const screen_offset = screen_height - expected.length;
            if(screen_offset >= 0)
            {
                let matches = true;
                for(let i = 0; i < expected.length && matches; i++)
                {
                    matches = contains_expected(screen_lines[screen_offset + i], expected[i]);
                }
                if(matches)
                {
                    succeeded = true;
                    break;
                }
            }
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        for(const row of changed_rows)
        {
            const screen_line = this.screen_adapter.get_text_row(row);
            if(match_multi)
            {
                screen_lines[row] = screen_line.trimRight();
            }
            else if(contains_expected(screen_line, expected))
            {
                succeeded = true;
                break loop;
            }
        }
        changed_rows.clear();
    }

    this.remove_listener("screen-put-char", screen_put_char);
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
    return this.v86.cpu.read_blob(offset, length);
};

/**
 * Writes data to memory at specified offset.
 *
 * @param {Array.<number>|Uint8Array} blob
 * @param {number} offset
 */
V86.prototype.write_memory = function(blob, offset)
{
    this.v86.cpu.write_blob(blob, offset);
};

V86.prototype.set_serial_container_xtermjs = function(element)
{
    this.serial_adapter && this.serial_adapter.destroy && this.serial_adapter.destroy();
    this.serial_adapter = new SerialAdapterXtermJS(element, this.bus);
    this.serial_adapter.show();
};

V86.prototype.get_instruction_stats = function()
{
    return print_stats.stats_to_string(this.v86.cpu);
};

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
