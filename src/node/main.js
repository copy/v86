"use strict";

/** @define {boolean} */
var IN_CLOSURE = false;

var path = __dirname + "/../",
    bios_path = path + "../bios/",
    image_path = path + "../images/";

function local_require(file) 
{
    if(IN_CLOSURE)
    {
        // handled by closure compiler
    }
    else
    {
        require(file);
    }
}

// otherwise tty ouput is used
var USE_SDL = true,
    FONT_FILE = path + "node/ascii.ttf";

function log(str)
{
    console.log(str);
}

var envapi = {
    log: log,
};

(function()
{
    var tick_fn;

    envapi.set_tick = function(fn)
    {
        tick_fn = fn;   
    };

    envapi.next_tick = function()
    {
        setImmediate(tick_fn);
    };
})();

var fs = require('fs'),
    vm = require('vm'),
    
    include = function(path) 
    {
        if(!IN_CLOSURE)
        {
            // ugh ...
            var code = fs.readFileSync(path);
            vm.runInThisContext(code, path);
        }
    }.bind(this);

include(path + "const.js");
include(path + "cpu.js");
include(path + "main.js");
include(path + "floppy.js");
include(path + "memory.js");
include(path + "io.js");
include(path + "pci.js");
include(path + "ide.js");
include(path + "dma.js");
include(path + "pit.js");
include(path + "vga.js");
include(path + "ps2.js");
include(path + "pic.js");
include(path + "uart.js");
include(path + "rtc.js");



function read_array_buffer(file)
{
    var buffer = fs.readFileSync(file),
        ab = new ArrayBuffer(buffer.length),
        arr = new Uint8Array(ab);

    for (var i = 0; i < buffer.length; i++) 
    {
        arr[i] = buffer[i];
    }

    return ab;
}


var settings = {
        load_devices: true,
    },
    argv = process.argv;


if(USE_SDL)
{
    var sdl = require("node-sdl");

    include(path + "node/keyboard_sdl.js");
    include(path + "node/screen_sdl.js");

    settings.screen_adapter = new NodeScreenSDL(sdl, FONT_FILE);
    settings.keyboard_adapter = new NodeKeyboardSDL(sdl);
}
else
{
    require('tty').setRawMode(true);

    include(path + "node/keyboard_tty.js");
    include(path + "node/screen_tty.js");

    settings.screen_adapter = new NodeScreenTTY();
    settings.keyboard_adapter = new NodeKeyboardTTY();
}


// just a prototype of a loader

if(argv && argv.length === 4 && (argv[2] === "cdrom" || argv[2] === "fda" || argv[2] === "hda"))
{
    var disk = new SyncBuffer(read_array_buffer(argv[3]));

    if(argv[2] === "cdrom")
    {
        settings.cdrom = disk;
    }
    else if(argv[2] === "fda")
    {
        settings.fda = disk;
    }
    else if(argv[2] === "hda")
    {
        settings.hda = disk;
    }


    settings.bios = read_array_buffer(bios_path + "seabios.bin");
    settings.vga_bios = read_array_buffer(bios_path + "vgabios.bin");

    settings.screen_adapter

    var cpu = new v86(envapi);

    cpu.init(settings);
    cpu.run();
}
else
{
    console.log("Usage: node main.js [cdrom|fda|hda] disk.img");

    process.exit();
}


