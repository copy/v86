#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });

var V86 = require("../../build/libv86-debug.js").V86;
var fs = require("fs");

const config_async_cdrom = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux3.iso", async: true },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
};

const config_sync_cdrom = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux3.iso", async: false },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
};

function run_test(name, config, done)
{
    const emulator = new V86(config);

    setTimeout(function()
        {
            console.log("Saving: %s", name);
            emulator.save_state(function(error, state)
                {
                    console.assert(!error);

                    setTimeout(function()
                        {
                            console.log("Restoring: %s", name);
                            emulator.restore_state(state);

                            setTimeout(function()
                                {
                                    console.log("Done: %s", name);
                                    emulator.stop();
                                    done();
                                }, 1000);
                        }, 1000);
                });
        }, 1000);
}

run_test("async cdrom", config_async_cdrom, function()
    {
        run_test("sync cdrom", config_sync_cdrom, function() {});
    });
