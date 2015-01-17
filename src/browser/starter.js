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
 * - `autostart boolean` (false) - If emulation should be started when emulator
 *   is ready.
 * - `disable_keyboard boolean` (false) - If the keyboard should be disabled.
 * - `disable_mouse boolean` (false) - If the mouse should be disabled.
 * - `network_relay_url string` (No network card) - The url of a server running
 *   websockproxy. See
 *   https://github.com/copy/v86/blob/master/docs/networking.md.
 * - `bios Object` (No bios) - Either a url pointing to a bios or an
 *   ArrayBuffer, see below.
 * - `vga_bios Object` (No VGA bios) - VGA bios, see below.
 * - `hda Object` (No hard drive) - First hard disk, see below.
 * - `fda Object` (No floppy disk) - First floppy disk, see below.
 * - `cdrom Object` (No cd drive) - CD disk, see below.
 * - `initial_state Object` (Normal boot) - An initial state to load, see
 *   [`restore_state`](#restore_statearraybuffer-state) and below.
 * - `serial_container HTMLTextAreaElement` (No serial terminal) - A textarea
 *   that will receive and send data to the emulated serial terminal.
 *   Alternatively the serial terminal can also be accessed programatically,
 *   see https://github.com/copy/v86/blob/master/docs/samples/serial.html.
 * - `screen_container HTMLElement` (No screen) - An HTMLElement. This should
 *   have a certain structure, see
 *   https://github.com/copy/v86/blob/master/docs/samples/basic.html.
 *
 * There are two ways to load images (`bios`, `vga_bios`, `cdrom`, `hda`, ...):
 *
 * - Pass an object that has a url: `options.bios = { url:
 *   "http://copy.sh/v86/bios/seabios.bin" }`. Optionally, `async: true` can be
 *   added to the object, so that sectors of the image are loaded on demand
 *   instead of being loaded before boot (slower, but strongly recommended for
 *   big files).
 * - Pass an `ArrayBuffer` or `File` object, for instance `options.hda = {
 *   buffer: new ArrayBuffer(512 * 1024) }` to add an empty hard drive.
 *
 *
 * @param {Object} options Options to initialize the emulator with.
 * @constructor 
 */
function V86Starter(options)
{
    var bus = Bus.create();
    var adapter_bus = this.bus = bus[0];

    this.emulator_bus = bus[1];

    var emulator = this.v86 = new v86(bus[1]);

    var settings = {};

    settings.load_devices = true;
    settings.memory_size = options["memory_size"] || 64 * 1024 * 1024;
    settings.vga_memory_size = options["vga_memory_size"] || 8 * 1024 * 1024;
    settings.boot_order = options["boot_order"] || 0x213;
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
        this.mouse_adapter = new MouseAdapter(adapter_bus);
    }

    if(options["screen_container"])
    {
        this.screen_adapter = new ScreenAdapter(options["screen_container"], adapter_bus);
    }

    if(options["serial_container"])
    {
        this.serial_adapter = new SerialAdapter(options["serial_container"], adapter_bus);
    }
    //settings.serial_adapter = new ModemAdapter();

    var files_to_load = [];

    function add_file(file, handler)
    {
        if(!file)
        {
            return;
        }

        if(file.buffer)
        {
            console.assert(
                file.buffer instanceof ArrayBuffer || file.buffer instanceof File,
                "buffer should be ArrayBuffer or File"
            );
            handler(file.buffer);
        }
        else if(file.url)
        {
            if(file.async)
            {
                handler(file);
            }
            else
            {
                files_to_load.push({
                    url: file.url,
                    handler: handler,
                    size: file.size,
                    as_text: file.as_text,
                });
            }
        }
    }

    function put_on_settings(name, buffer)
    {
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
            case "bios":
                settings.bios = buffer;
                break;
            case "vga_bios":
                settings.vga_bios = buffer;
                break;
            default:
                dbg_assert(false, name);
        }
    }

    function make_sync_buffer(name, buffer)
    {
        if(buffer instanceof ArrayBuffer)
        {
            var result = new SyncBuffer(buffer);
        }
        else if(buffer instanceof File)
        {
            // SyncFileBuffer:
            // - loads the whole disk image into memory, impossible for large files (more than 1GB)
            // - can later serve get/set operations fast and synchronously 
            // - takes some time for first load, neglectable for small files (up to 100Mb)
            //
            // AsyncFileBuffer:
            // - loads slices of the file asynchronously as requested
            // - slower get/set

            var result;

            // Heuristics: If file is smaller than 16M, use SyncFileBuffer
            if(buffer.size < 16 * 1024 * 1024)
            {
                result = new v86util.SyncFileBuffer(buffer);
                result.load();
            }
            else
            {
                result = new v86util.AsyncFileBuffer(buffer);
            }
            //settings[name] = new SyncFileBuffer(buffer);
        }
        else if(buffer.async)
        {
            var result = new v86util.AsyncXHRBuffer(buffer.url, 512, buffer.size);
        }
        else
        {
            console.assert(false);
        }

        put_on_settings(name, result);
    }

    add_file(options["bios"], put_on_settings.bind(this, "bios"));
    add_file(options["vga_bios"], put_on_settings.bind(this, "vga_bios"));

    add_file(options["cdrom"], make_sync_buffer.bind(this, "cdrom"));
    add_file(options["hda"], make_sync_buffer.bind(this, "hda"));
    add_file(options["hdb"], make_sync_buffer.bind(this, "hdb"));
    add_file(options["fda"], make_sync_buffer.bind(this, "fda"));
    add_file(options["fdb"], make_sync_buffer.bind(this, "fdb"));

    if(options["filesystem"])
    {
        var fs9p = new FS(options["filesystem"].baseurl);

        settings.fs9p = fs9p;

        add_file({ url: options["filesystem"].basefs, as_text: true, }, function(text)
        {
            //fs9p.LoadFilesystem({
            //    basefsURL: options["filesystem"].basefs,
            //});
            fs9p.OnJSONLoaded(text);
        });
    }

    var initial_state_buffer;
    if(options["initial_state"])
    {
        add_file(options["initial_state"], function(buffer)
        {
            initial_state_buffer = buffer;
        });
    }

    var starter = this;
    cont(0);

    function cont(index)
    {
        var total = files_to_load.length;

        if(index < total)
        {
            var f = files_to_load[index];

            v86util.load_file(f.url, {
                done: function done(result)
                {
                    f.handler(result);
                    cont(index + 1);
                }, 
                progress: function progress(e)
                {
                    starter.emulator_bus.send("download-progress", {
                        file_index: index,
                        file_count: total,

                        lengthComputable: e.lengthComputable,
                        total: f.size || e.total,
                        loaded: e.loaded,
                    });
                },
                as_text: f.as_text,
            });
        }
        else
        {
            emulator.init(settings);

            if(initial_state_buffer)
            {
                emulator.restore_state(initial_state_buffer);
            }

            if(options["autostart"])
            {
                emulator.run();
            }
        }
    }
}

/**
 * Start emulation. Do nothing if emulator is running already. Can be
 * asynchronous.
 */
V86Starter.prototype.run = function()
{
    this.v86.run();
};

/**
 * Stop emulation. Do nothing if emulator is not running. Can be asynchronous.
 */
V86Starter.prototype.stop = function()
{
    this.v86.stop();
};

/**
 * Restart (force a reboot).
 */
V86Starter.prototype.restart = function()
{
    this.v86.restart();
};

/**
 * Add an event listener (the emulator is an event emitter). A list of events
 * can be found at https://github.com/copy/v86/blob/master/docs/events.md.
 *
 * The callback function gets a single argument which depends on the event.
 *
 * @param {string} event Name of the event.
 * @param {function(*)} listener The callback function. 
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
 */
V86Starter.prototype.save_state = function(callback)
{
    // Might become asynchronous at some point
    
    var emulator = this;

    setTimeout(function()
    {
        try
        {
            callback(null, emulator.v86.save_state());
        }
        catch(e)
        {
            callback(e, null);
        }
    }, 0);
};

/**
 * Return an object with several statistics. Return value looks similar to
 * (but can be subject to change in future versions or different
 * configurations, so use defensively):
 *
 * ```
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
 * @return {Object}
 */
V86Starter.prototype.get_statistics = function()
{
    var stats = {
        cpu: {
            instruction_counter: this.get_instruction_counter(),
        },
    };

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
        stats.mouse = {
            enabled: devices.ps2.use_mouse,
        };
    }

    if(devices.vga)
    {
        stats.vga = devices.vga.stats;
    }

    return stats;
};

/**
 * @return {number}
 * @ignore
 */
V86Starter.prototype.get_instruction_counter = function()
{
    return this.v86.cpu.timestamp_counter;
};

/**
 * @return {boolean}
 */
V86Starter.prototype.is_running = function()
{
    return this.v86.running;
};

/** 
 * Send a sequence of scan codes to the emulated PS2 controller. A list of
 * codes can be found at http://stanislavs.org/helppc/make_codes.html.
 * Do nothing if there is not keyboard controller.
 *
 * @param {Array.<number>} codes
 */
V86Starter.prototype.keyboard_send_scancodes = function(codes)
{
    var ps2 = this.v86.cpu.devices.ps2;

    for(var i = 0; i < codes.length; i++)
    {
        ps2.kbd_send_code(codes[i]);
    }
};

/**
 * Download a screenshot.
 * 
 * @ignore
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
 */
V86Starter.prototype.serial0_send = function(data)
{
    for(var i = 0; i < data.length; i++)
    {
        this.bus.send("serial0-input", data.charCodeAt(i));
    }
};

// Closure Compiler's way of exporting 
if(typeof window !== "undefined")
{
    window["V86Starter"] = V86Starter;
}
else if(typeof module !== "undefined" && typeof module.exports !== "undefined")
{
    module.exports["V86Starter"] = V86Starter;
}

V86Starter.prototype["run"] = V86Starter.prototype.run;
V86Starter.prototype["stop"] = V86Starter.prototype.stop;
V86Starter.prototype["restart"] = V86Starter.prototype.restart;
V86Starter.prototype["add_listener"] = V86Starter.prototype.add_listener;
V86Starter.prototype["remove_listener"] = V86Starter.prototype.remove_listener;
V86Starter.prototype["restore_state"] = V86Starter.prototype.restore_state;
V86Starter.prototype["save_state"] = V86Starter.prototype.save_state;
V86Starter.prototype["get_statistics"] = V86Starter.prototype.get_statistics;
V86Starter.prototype["is_running"] = V86Starter.prototype.is_running;
V86Starter.prototype["keyboard_send_scancodes"] = V86Starter.prototype.keyboard_send_scancodes;
V86Starter.prototype["screen_make_screenshot"] = V86Starter.prototype.screen_make_screenshot;
V86Starter.prototype["screen_set_scale"] = V86Starter.prototype.screen_set_scale;
V86Starter.prototype["screen_go_fullscreen"] = V86Starter.prototype.screen_go_fullscreen;
V86Starter.prototype["lock_mouse"] = V86Starter.prototype.lock_mouse;
V86Starter.prototype["mouse_set_status"] = V86Starter.prototype.mouse_set_status;
V86Starter.prototype["keyboard_set_status"] = V86Starter.prototype.keyboard_set_status;
V86Starter.prototype["serial0_send"] = V86Starter.prototype.serial0_send;
