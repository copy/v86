"use strict";

/** @constructor */
function V86Starter(options)
{
    this.screen_adapter = undefined;

    var bus = Bus.create();
    var adapter_bus = this.bus = bus[0];

    this.emulator_bus = bus[1];

    var emulator = this.v86 = new v86(bus[1]);

    var settings = {};

    settings.load_devices = true;
    settings.memory_size = options["memory_size"];
    settings.vga_memory_size = options["vga_memory_size"];
    settings.boot_order = options["boot_order"] || 0x213;
    settings.fda = undefined;
    settings.fdb = undefined;

    if(options["network_relay_url"])
    {
        settings.network_adapter = new NetworkAdapter(options["network_relay_url"], adapter_bus);
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
            console.assert(file.buffer instanceof ArrayBuffer || file.buffer instanceof File);
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

            // Heuristics: If file is smaller than 64M, use SyncFileBuffer
            //if(file.size < 64 * 1024 * 1024)
            
            var result = new v86util.AsyncFileBuffer(buffer);
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

    if(options.filesystem)
    {
        var fs9p = new FS(options.filesystem.baseurl);

        settings.fs9p = fs9p;

        //add_file(infos.filesystem.basefs, function()
        //{
            fs9p.LoadFilesystem({
                basefsURL: options.filesystem.basefs,
            });
        //});
    }

    var initial_state_buffer;
    if(options["initial_state"])
    {
        add_file(options["initial_state"], function(buffer)
        {
            console.log(options["initial_state"], buffer);
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

            v86util.load_file(f.url, function done(result)
            {
                f.handler(result);
                cont(index + 1);
            }, function progress(e)
            {
                starter.emulator_bus.send("download-progress", {
                    file_index: index,
                    file_count: total,

                    lengthComputable: e.lengthComputable,
                    total: f.size || e.total,
                    loaded: e.loaded,
                });
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
 * Start emulation. Do nothing if emulator is running already.
 */
V86Starter.prototype.run = function()
{
    this.v86.run();
};

/**
 * Stop emulation. Do nothing if emulator is not running.
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
 * @param {string} event
 * @param {function(*)} listener
 */
V86Starter.prototype.add_listener = function(event, listener)
{
    this.bus.register(event, listener, this);
};

/**
 * @param {string} event
 * @param {function(*)} listener
 */
V86Starter.prototype.remove_listener = function(event, listener)
{
    this.bus.unregister(event, listener);
};

/**
 * @param {ArrayBuffer} state
 */
V86Starter.prototype.restore_state = function(state)
{
    this.v86.restore_state(state);
};

/**
 * @param {function(Object, ArrayBuffer)} callback
 */
V86Starter.prototype.save_state = function(callback)
{
    // Might become asynchronous at some point
    
    var emulator = this;

    setTimeout(function()
    {
        callback(null, emulator.v86.save_state());
    }, 0);
};

/**
 * @return {Object}
 */
V86Starter.prototype.get_statistics = function()
{
    var stats = {
        cpu: {
            instruction_counter: this.v86.cpu.timestamp_counter,
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
            enabled: devices.ps2.enable_mouse,
        };
    }

    if(devices.vga)
    {
        stats.vga = devices.vga.stats;
    }

    return stats;
};

/**
 * @return {boolean}
 */
V86Starter.prototype.is_running = function()
{
    return this.v86.running;
};

/** 
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
 * Download a screenshot
 */
V86Starter.prototype.screen_make_screenshot = function()
{
    if(this.screen_adapter)
    {
        this.screen_adapter.make_screenshot();
    }
};

/**
 * Set the scaling level of the emulated screen 
 *
 * @param {number} sx
 * @param {number} sy
 */
V86Starter.prototype.screen_set_scale = function(sx, sy)
{
    if(this.screen_adapter)
    {
        this.screen_adapter.set_scale(sx, sy);
    }
};

/**
 * Make the browser go fullscreen
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
 * Lock the mouse button (it is inivisble and movements are only registered in
 * the emulator
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
 * Enable or disable sending mouse events to the emulated PS2 controller
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
 * Send a string to the first emulated serial terminal
 *
 * @param {string} data
 */
V86Starter.prototype.serial0_send = function(data)
{
    for(var i = 0; i < data.length; i++)
    {
        this.serial_adapter.send_char(data.charCodeAt(i));
    }
};

// Closure Compiler's way of exporting 
if(typeof window !== "undefined")
{
    window["V86Starter"] = V86Starter;

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
    V86Starter.prototype["serial0_send"] = V86Starter.prototype.serial0_send;
}
