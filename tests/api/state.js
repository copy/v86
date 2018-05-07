#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });

var V86 = require("../../build/libv86-debug.js").V86;
var fs = require("fs");

var emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux3.iso", "async": true },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
});

setTimeout(function()
    {
        emulator.save_state(function(error, state)
            {
                console.assert(!error);

                setTimeout(function()
                    {
                        emulator.restore_state(state);

                        setTimeout(function()
                            {
                                console.log("Stopping ...");
                                emulator.stop();
                            }, 1000);
                    }, 1000);
            });
    }, 1000);
