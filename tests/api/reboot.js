#!/usr/bin/env node
"use strict";

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;

const fs = require("fs");
var V86 = require(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.js`).V86;

process.on("unhandledRejection", exn => { throw exn; });

const config = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: true },
    net_device: {
        relay_url: "fetch",
        type: "virtio",
    },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    virtio_console: true,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
};

const emulator = new V86(config);

let did_reboot = false;
let serial_text = "";

const timeout = setTimeout(() => {
    console.log(serial_data);
    throw new Error("Timeout");
}, 120 * 1000);

emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);
    serial_text += chr;

    if(did_reboot)
    {
        if(serial_text.endsWith("Files send via emulator appear in /mnt/"))
        {
            console.log("Ok");
            emulator.destroy();
            clearTimeout(timeout);
        }
    }
    else
    {
        if(serial_text.endsWith("~% "))
        {
            console.log("rebooting");
            emulator.serial0_send("reboot\n");
            serial_text = "";
            did_reboot = true;
        }
    }
});
