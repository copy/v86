#!/usr/bin/env node
"use strict";

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;

const fs = require("fs");
var V86 = require(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.js`).V86;

process.on("unhandledRejection", exn => { throw exn; });

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    hda: { url: __dirname + "/../../images/msdos.img" },
    network_relay_url: "<UNUSED>",
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
    screen_dummy: true,
});

emulator.automatically([
    { sleep: 1 },
    { vga_text: "C:\\> " },
    { keyboard_send: "dir A:\n" },
    { vga_text: "Abort, Retry, Fail?" },
    { keyboard_send: "F" },
    { call: () => {
            emulator.set_fda({ url: __dirname + "/../../images/freedos722.img" });
        },
    },
    { keyboard_send: "dir A:\n" },
    { sleep: 1 },
    { vga_text: "FDOS         <DIR>" },
    { call: () => {
            console.log("Passed");
            emulator.stop();
        }
    },
]);
