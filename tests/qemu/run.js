#!/usr/bin/env node
"use strict";

var V86 = require("../../build/libv86.js").V86;
var fs = require("fs");

var test_executable = new Uint8Array(fs.readFileSync(__dirname + "/test-i386"));

var emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux3.iso" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
});

emulator.bus.register("emulator-started", function()
{
    console.error("Booting now, please stand by");
    emulator.create_file("test-i386", test_executable);
});

var ran_command = false;
var line = "";

emulator.add_listener("serial0-output-char", function(chr)
{
    if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
    {
        return;
    }

    if(chr === "\n")
    {
        var new_line = line;
        console.error("Serial: %s", line);
        line = "";
    }
    else
    {
        line += chr;
    }

    if(!ran_command && line.endsWith("~% "))
    {
        ran_command = true;
        emulator.serial0_send("chmod +x /mnt/test-i386\n");
        emulator.serial0_send("/mnt/test-i386 > /mnt/result\n");
        emulator.serial0_send("echo test fini''shed\n");
    }

    if(new_line && new_line.includes("test finished"))
    {
        console.error("Done. Reading result ...");

        emulator.read_file("/result", function(err, data)
            {
                if(err) throw err;
                console.error("Got result, writing to stdout");
                process.stdout.write(new Buffer(data));
                emulator.stop();
            });
    }

});
