#!/usr/bin/env node
"use strict";

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;

const fs = require("fs");
var V86 = require(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.js`).V86;

process.on("unhandledRejection", exn => { throw exn; });

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    hda: { url: __dirname + "/../../images/freedos13.img" },
    wants_cdrom: true,
    network_relay_url: "<UNUSED>",
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
    screen_dummy: true,
});

emulator.automatically([
    { sleep: 1 },
    { vga_text: "JEMM386" },
    { sleep: 1 },
    { keyboard_send: "3" },
    { vga_text: "C:\\> " },
    { keyboard_send: "dir D:\n" },
    { vga_text: "(A)bort, (R)etry, (F)ail?" },
    { keyboard_send: "f" },
    { sleep: 10 },
    { vga_text: "(A)bort, (R)etry, (F)ail?" },
    { keyboard_send: "f" },
    { sleep: 10 },
    { vga_text: "(A)bort, (R)etry, (F)ail?" },
    { keyboard_send: "f" },
    { sleep: 10 },
    { call: () => {
            emulator.set_cdrom({ url: __dirname + "/../../images/FD13LIVE.iso" });
        },
    },
    { sleep: 5 },
    { keyboard_send: "dir D:\n" },
    { vga_text: "Volume in drive D is FD13-LiveCD" },
    { call: () => {
            console.log("Passed");
            emulator.stop();
        }
    },
]);
