#!/usr/bin/env node
"use strict";

// This test checks that calling emulator.stop() will remove all event
// listeners, so that the nodejs process cleanly and automatically exits.

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;

const fs = require("fs");
var V86 = require(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.js`).V86;

process.on("unhandledRejection", exn => { throw exn; });

const config = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: true },
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
