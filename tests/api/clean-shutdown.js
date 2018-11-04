#!/usr/bin/env node
"use strict";

// This test checks that calling emulator.stop() will remove all event
// listeners, so that the nodejs process cleanly and automatically exits.

const fs = require("fs");
const V86 = require("../../build/libv86-debug.js").V86;

process.on("unhandledRejection", exn => { throw exn; });

const config = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux3.iso", async: true },
    network_relay_url: "<UNUSED>",
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
    screen_dummy: true,
};

const emulator = new V86(config);

setTimeout(function()
    {
        console.error("Calling stop()");
        emulator.stop();
        console.error("Called stop()");
    }, 3000);
