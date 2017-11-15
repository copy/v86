"use strict";

/**
 * Constructor for emulator instances.
 *
 * Usage: `var emulator = new V86Starter(options);`
 *
 * Options can have the following properties (all optional, default in parenthesis):
 *
 * - `memory_size number` (16 * 1024 * 1024) - The memory size in bytes, should
 *   be a power of 2.
 * - `vga_memory_size number` (8 * 1024 * 1024) - VGA memory size in bytes.
 *
 * - `autostart boolean` (false) - If emulation should be started when emulator
 *   is ready.
 *
 * - `disable_keyboard boolean` (false) - If the keyboard should be disabled.
 * - `disable_mouse boolean` (false) - If the mouse should be disabled.
 *
 * - `network_relay_url string` (No network card) - The url of a server running
 *   websockproxy. See [networking.md](networking.md). Setting this will
 *   enable an emulated network card.
 *
 * - `bios Object` (No bios) - Either a url pointing to a bios or an
 *   ArrayBuffer, see below.
 * - `vga_bios Object` (No VGA bios) - VGA bios, see below.
 * - `hda Object` (No hard drive) - First hard disk, see below.
 * - `fda Object` (No floppy disk) - First floppy disk, see below.
 * - `cdrom Object` (No CD) - See below.
 * - `initial_state Object` (Normal boot) - An initial state to load, see
 *   [`restore_state`](#restore_statearraybuffer-state) and below.
 *
 * - `filesystem Object` (No 9p filesystem) - A 9p filesystem, see
 *   [filesystem.md](filesystem.md).
 *
 * - `serial_container HTMLTextAreaElement` (No serial terminal) - A textarea
 *   that will receive and send data to the emulated serial terminal.
 *   Alternatively the serial terminal can also be accessed programatically,
 *   see [serial.html](../examples/serial.html).
 *
 * - `screen_container HTMLElement` (No screen) - An HTMLElement. This should
 *   have a certain structure, see [basic.html](../examples/basic.html).
 *
 * ***
 *
 * There are two ways to load images (`bios`, `vga_bios`, `cdrom`, `hda`, ...):
 *
 * - Pass an object that has a url. Optionally, `async: true` and `size:
 *   size_in_bytes` can be added to the object, so that sectors of the image
 *   are loaded on demand instead of being loaded before boot (slower, but
 *   strongly recommended for big files). In that case, the `Range: bytes=...`
 *   header must be supported on the server.
 *
 *   ```javascript
 *   // download file before boot
 *   bios: {
 *       url: "bios/seabios.bin"
 *   }
 *   // download file sectors as requested, size is required
 *   hda: {
 *       url: "disk/linux.iso",
 *       async: true,
 *       size: 16 * 1024 * 1024
 *   }
 *   ```
 *
 * - Pass an `ArrayBuffer` or `File` object as `buffer` property.
 *
 *   ```javascript
 *   // use <input type=file>
 *   bios: {
 *       buffer: document.all.hd_image.files[0]
 *   }
 *   // start with empty hard drive
 *   hda: {
 *       buffer: new ArrayBuffer(16 * 1024 * 1024)
 *   }
 *   ```
 *
 * ***
 *
 * @param {Object} options Options to initialize the emulator with.
 * @constructor
 */
function V86Starter(options)
{
    //var worker = new Worker("src/browser/worker.js");
    //var adapter_bus = this.bus = WorkerBus.init(worker);

    this.cpu_is_running = false;

    var bus = Bus.create();
    var adapter_bus = this.bus = bus[0];
    this.emulator_bus = bus[1];
    var emulator = this.v86 = new v86(this.emulator_bus);

    this.bus.register("emulator-stopped", function()
    {
        this.cpu_is_running = false;
    }, this);

    this.bus.register("emulator-started", function()
    {
        this.cpu_is_running = true;
    }, this);

    var settings = {};

    this.disk_images = {
        "fda": undefined,
        "fdb": undefined,
        "hda": undefined,
        "hdb": undefined,
        "cdrom": undefined,
    };

    settings.load_devices = true;
    settings.memory_size = options["memory_size"] || 64 * 1024 * 1024;
    settings.vga_memory_size = options["vga_memory_size"] || 8 * 1024 * 1024;
    settings.boot_order = options["boot_order"] || 0x213;
    settings.fastboot = options["fastboot"] || false;
    settings.fda = undefined;
    settings.fdb = undefined;

    if(options["network_relay_url"])
    {
        this.network_adapter = new NetworkAdapter(options["network_relay_url"], adapter_bus);
        settings.enable_ne2k = true;
    }

    if(!options["disable_keyboard"])
    {
        this.keyboard_adapter = new KeyboardAdapter(adapter_bus);
    }
    if(!options["disable_mouse"])
    {
        this.mouse_adapter = new MouseAdapter(adapter_bus, options["screen_container"]);
    }

    if(options["screen_container"])
    {
        this.screen_adapter = new ScreenAdapter(options["screen_container"], adapter_bus);
    }
    else if(options["screen_dummy"])
    {
        this.screen_adapter = new DummyScreenAdapter(adapter_bus);
    }

    if(options["serial_container"])
    {
        this.serial_adapter = new SerialAdapter(options["serial_container"], adapter_bus);
    }

    if(!options["disable_speaker"])
    {
        this.speaker_adapter = new SpeakerAdapter(adapter_bus);
    }

    // ugly, but required for closure compiler compilation
    function put_on_settings(name, buffer)
    {
        switch(name)
        {
            case "hda":
                settings.hda = this.disk_images["hda"] = buffer;
                break;
            case "hdb":
                settings.hdb = this.disk_images["hdb"] = buffer;
                break;
            case "cdrom":
                settings.cdrom = this.disk_images["cdrom"] = buffer;
                break;
            case "fda":
                settings.fda = this.disk_images["fda"] = buffer;
                break;
            case "fdb":
                settings.fdb = this.disk_images["fdb"] = buffer;
                break;

            case "multiboot":
                settings.multiboot = this.disk_images["multiboot"] = buffer;
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
                settings.fs9p_json = buffer.buffer;
                break;
            default:
                dbg_assert(false, name);
        }
    }

    var files_to_load = [];

    function add_file(name, file)
    {
        if(!file)
        {
            return;
        }

        if(file["get"] && file["set"] && file["load"])
        {
            files_to_load.push({
                name: name,
                loadable: file,
            });
            return;
        }

        // Anything coming from the outside world needs to be quoted for
        // Closure Compiler compilation
        file = {
            buffer: file["buffer"],
            async: file["async"],
            url: file["url"],
            size: file["size"],
        };

        if(name === "bios" || name === "vga_bios" ||
            name === "initial_state" || name === "multiboot")
        {
            // Ignore async for these because they must be availabe before boot.
            // This should make result.buffer available after the object is loaded
            file.async = false;
        }

        if(file.buffer instanceof ArrayBuffer)
        {
            var buffer = new SyncBuffer(file.buffer);
            files_to_load.push({
                name: name,
                loadable: buffer,
            });
        }
        else if(typeof File !== "undefined" && file.buffer instanceof File)
        {
            // SyncFileBuffer:
            // - loads the whole disk image into memory, impossible for large files (more than 1GB)
            // - can later serve get/set operations fast and synchronously
            // - takes some time for first load, neglectable for small files (up to 100Mb)
            //
            // AsyncFileBuffer:
            // - loads slices of the file asynchronously as requested
            // - slower get/set

            // Heuristics: If file is larger than or equal to 256M, use AsyncFileBuffer
            if(file.async === undefined)
            {
                file.async = file.buffer.size >= 256 * 1024 * 1024;
            }

            if(file.async)
            {
                var buffer = new v86util.AsyncFileBuffer(file.buffer);
            }
            else
            {
                var buffer = new v86util.SyncFileBuffer(file.buffer);
            }

            files_to_load.push({
                name: name,
                loadable: buffer,
            });
        }
        else if(file.url)
        {
            if(file.async)
            {
                var buffer = new v86util.AsyncXHRBuffer(file.url, file.size);
                files_to_load.push({
                    name: name,
                    loadable: buffer,
                });
            }
            else
            {
                files_to_load.push({
                    name: name,
                    url: file.url,
                    size: file.size,
                });
            }
        }
        else
        {
            dbg_log("Ignored file: url=" + file.url + " buffer=" + file.buffer);
        }
    }

    var image_names = [
        "bios", "vga_bios",
        "cdrom", "hda", "hdb", "fda", "fdb",
        "initial_state", "multiboot",
    ];

    for(var i = 0; i < image_names.length; i++)
    {
        add_file(image_names[i], options[image_names[i]]);
    }

    if(options["filesystem"])
    {
        var fs_url = options["filesystem"]["basefs"];
        var base_url = options["filesystem"]["baseurl"];

        this.fs9p = new FS(base_url);
        settings.fs9p = this.fs9p;

        if(fs_url)
        {
            console.assert(base_url, "Filesystem: baseurl must be specified");

            var size;

            if(typeof fs_url === "object")
            {
                size = fs_url["size"];
                fs_url = fs_url["url"];
            }
            dbg_assert(typeof fs_url === "string");

            files_to_load.push({
                name: "fs9p_json",
                url: fs_url,
                size: size,
                as_text: true,
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
            v86util.load_file(f.url, {
                done: function(result)
                {
                    put_on_settings.call(this, f.name, new SyncBuffer(result));
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
                as_text: f.as_text,
            });
        }
    }.bind(this);
    cont(0);

    function done()
    {
        if(settings.initial_state)
        {
            // avoid large allocation now, memory will be restored later anyway
            settings.memory_size = 0;
        }

        this.bus.send("cpu-init", settings);

        setTimeout(function()
        {
            if(settings.initial_state)
            {
                emulator.restore_state(settings.initial_state);
            }

            setTimeout(function()
            {
                if(settings.fs9p && settings.fs9p_json)
                {
                    settings.fs9p.OnJSONLoaded(settings.fs9p_json);
                }

                if(options["autostart"])
                {
                    this.bus.send("cpu-run");
                }
            }.bind(this), 0);
        }.bind(this), 0);
    }
}

/**
 * Start emulation. Do nothing if emulator is running already. Can be
 * asynchronous.
 * @export
 */
V86Starter.prototype.run = function()
{
    this.bus.send("cpu-run");
};

/**
 * Stop emulation. Do nothing if emulator is not running. Can be asynchronous.
 * @export
 */
V86Starter.prototype.stop = function()
{
    this.bus.send("cpu-stop");
};

/**
 * @ignore
 * @export
 */
V86Starter.prototype.destroy = function()
{
    this.keyboard_adapter.destroy();
};

/**
 * Restart (force a reboot).
 * @export
 */
V86Starter.prototype.restart = function()
{
    this.bus.send("cpu-restart");
};

/**
 * Add an event listener (the emulator is an event emitter). A list of events
 * can be found at [events.md](events.md).
 *
 * The callback function gets a single argument which depends on the event.
 *
 * @param {string} event Name of the event.
 * @param {function(*)} listener The callback function.
 * @export
 */
V86Starter.prototype.add_listener = function(event, listener)
{
    this.bus.register(event, listener, this);
};

/**
 * Remove an event listener.
 *
 * @param {string} event
 * @param {function(*)} listener
 * @export
 */
V86Starter.prototype.remove_listener = function(event, listener)
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
 * @export
 */
V86Starter.prototype.restore_state = function(state)
{
    this.v86.restore_state(state);
};

/**
 * Asynchronously save the current state of the emulator. The first argument to
 * the callback is an Error object if something went wrong and is null
 * otherwise.
 *
 * @param {function(Object, ArrayBuffer)} callback
 * @export
 */
V86Starter.prototype.save_state = function(callback)
{
    // Might become asynchronous at some point

    setTimeout(function()
    {
        try
        {
            callback(null, this.v86.save_state());
        }
        catch(e)
        {
            callback(e, null);
        }
    }.bind(this), 0);
};

/**
 * Return an object with several statistics. Return value looks similar to
 * (but can be subject to change in future versions or different
 * configurations, so use defensively):
 *
 * ```javascript
 * {
 *     "cpu": {
 *         "instruction_counter": 2821610069
 *     },
 *     "hda": {
 *         "sectors_read": 95240,
 *         "sectors_written": 952,
 *         "bytes_read": 48762880,
 *         "bytes_written": 487424,
 *         "loading": false
 *     },
 *     "cdrom": {
 *         "sectors_read": 0,
 *         "sectors_written": 0,
 *         "bytes_read": 0,
 *         "bytes_written": 0,
 *         "loading": false
 *     },
 *     "mouse": {
 *         "enabled": true
 *     },
 *     "vga": {
 *         "is_graphical": true,
 *         "res_x": 800,
 *         "res_y": 600,
 *         "bpp": 32
 *     }
 * }
 * ```
 *
 * @deprecated
 * @return {Object}
 * @export
 */
V86Starter.prototype.get_statistics = function()
{
    console.warn("V86Starter.prototype.get_statistics is deprecated. Use events instead.");

    var stats = {
        cpu: {
            instruction_counter: this.get_instruction_counter(),
        },
    };

    if(!this.v86)
    {
        return stats;
    }

    var devices = this.v86.cpu.devices;

    if(devices.hda)
    {
        stats.hda = devices.hda.stats;
    }

    if(devices.cdrom)
    {
        stats.cdrom = devices.cdrom.stats;
    }

    if(devices.ps2)
    {
        stats["mouse"] = {
            "enabled": devices.ps2.use_mouse,
        };
    }

    if(devices.vga)
    {
        stats["vga"] = {
            "is_graphical": devices.vga.stats.is_graphical,
        };
    }

    return stats;
};

/**
 * @return {number}
 * @ignore
 * @export
 */
V86Starter.prototype.get_instruction_counter = function()
{
    if(this.v86)
    {
        return this.v86.cpu.timestamp_counter;
    }
    else
    {
        // TODO: Should be handled using events
        return 0;
    }
};

/**
 * @return {boolean}
 * @export
 */
V86Starter.prototype.is_running = function()
{
    return this.cpu_is_running;
};

/**
 * Send a sequence of scan codes to the emulated PS2 controller. A list of
 * codes can be found at http://stanislavs.org/helppc/make_codes.html.
 * Do nothing if there is no keyboard controller.
 *
 * @param {Array.<number>} codes
 * @export
 */
V86Starter.prototype.keyboard_send_scancodes = function(codes)
{
    for(var i = 0; i < codes.length; i++)
    {
        this.bus.send("keyboard-code", codes[i]);
    }
};

/**
 * Send translated keys
 * @ignore
 * @export
 */
V86Starter.prototype.keyboard_send_keys = function(codes)
{
    for(var i = 0; i < codes.length; i++)
    {
        this.keyboard_adapter.simulate_press(codes[i]);
    }
};

/**
 * Send text
 * @ignore
 * @export
 */
V86Starter.prototype.keyboard_send_text = function(string)
{
    for(var i = 0; i < string.length; i++)
    {
        this.keyboard_adapter.simulate_char(string[i]);
    }
};

/**
 * Download a screenshot.
 *
 * @ignore
 * @export
 */
V86Starter.prototype.screen_make_screenshot = function()
{
    if(this.screen_adapter)
    {
        this.screen_adapter.make_screenshot();
    }
};

/**
 * Set the scaling level of the emulated screen.
 *
 * @param {number} sx
 * @param {number} sy
 *
 * @ignore
 * @export
 */
V86Starter.prototype.screen_set_scale = function(sx, sy)
{
    if(this.screen_adapter)
    {
        this.screen_adapter.set_scale(sx, sy);
    }
};

/**
 * Go fullscreen.
 *
 * @ignore
 * @export
 */
V86Starter.prototype.screen_go_fullscreen = function()
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

    //this.lock_mouse(elem);
    this.lock_mouse();
};

/**
 * Lock the mouse cursor: It becomes invisble and is not moved out of the
 * browser window.
 *
 * @ignore
 * @export
 */
V86Starter.prototype.lock_mouse = function()
{
    var elem = document.body;

    var fn = elem["requestPointerLock"] ||
                elem["mozRequestPointerLock"] ||
                elem["webkitRequestPointerLock"];

    if(fn)
    {
        fn.call(elem);
    }
};

/**
 * Enable or disable sending mouse events to the emulated PS2 controller.
 *
 * @param {boolean} enabled
 */
V86Starter.prototype.mouse_set_status = function(enabled)
{
    if(this.mouse_adapter)
    {
        this.mouse_adapter.emu_enabled = enabled;
    }
};

/**
 * Enable or disable sending keyboard events to the emulated PS2 controller.
 *
 * @param {boolean} enabled
 * @export
 */
V86Starter.prototype.keyboard_set_status = function(enabled)
{
    if(this.keyboard_adapter)
    {
        this.keyboard_adapter.emu_enabled = enabled;
    }
};


/**
 * Send a string to the first emulated serial terminal.
 *
 * @param {string} data
 * @export
 */
V86Starter.prototype.serial0_send = function(data)
{
    for(var i = 0; i < data.length; i++)
    {
        this.bus.send("serial0-input", data.charCodeAt(i));
    }
};

/**
 * Write to a file in the 9p filesystem. Nothing happens if no filesystem has
 * been initialized. First argument to the callback is an error object if
 * something went wrong and null otherwise.
 *
 * @param {string} file
 * @param {Uint8Array} data
 * @param {function(Object)=} callback
 * @export
 */
V86Starter.prototype.create_file = function(file, data, callback)
{
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
        fs.CreateBinaryFile(filename, parent_id, data);
    }

    if(callback)
    {
        setTimeout(function()
        {
            if(not_found)
            {
                callback(new FileNotFoundError());
            }
            else
            {
                callback(null);
            }
        }, 0);
    }
};

/**
 * Read a file in the 9p filesystem. Nothing happens if no filesystem has been
 * initialized.
 *
 * @param {string} file
 * @param {function(Object, Uint8Array)} callback
 * @export
 */
V86Starter.prototype.read_file = function(file, callback)
{
    var fs = this.fs9p;

    if(!fs)
    {
        return;
    }

    var path_infos = fs.SearchPath(file);
    var id = path_infos.id;

    if(id === -1)
    {
        callback(new FileNotFoundError(), null);
    }
    else
    {
        fs.OpenInode(id, undefined);
        fs.AddEvent(
            id,
            function()
            {
                var data = fs.inodedata[id];

                if(data)
                {
                    callback(null, data.subarray(0, fs.inodes[id].size));
                }
                else
                {
                    callback(new FileNotFoundError(), null);
                }
            }
        );
    }
};

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

// Closure Compiler's way of exporting
if(typeof window !== "undefined")
{
    window["V86Starter"] = V86Starter;
    window["V86"] = V86Starter;
}
else if(typeof module !== "undefined" && typeof module.exports !== "undefined")
{
    module.exports["V86Starter"] = V86Starter;
    module.exports["V86"] = V86Starter;
}
else if(typeof importScripts === "function")
{
    // web worker
    self["V86Starter"] = V86Starter;
    self["V86"] = V86Starter;
}
