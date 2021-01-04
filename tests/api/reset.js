#!/usr/bin/env node
"use strict";

// This test checks that reset works

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

let did_restart = false;
let serial_text = "";

emulator.add_listener("serial0-output-char", function(chr)
{
    serial_text += chr;

    if(serial_text.includes("Files send via emulator appear in /mnt/")) {
        serial_text = "";
        if(did_restart) {
            console.log("Ok");
            emulator.stop();
        }
        else {
            console.log("Calling restart()");
            emulator.restart();
            did_restart = true;
        }
    }
});
