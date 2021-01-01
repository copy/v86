#!/usr/bin/env node
"use strict";

const path = require("path");
var V86 = require("../../build/libv86.js").V86;

const V86_ROOT = path.join(__dirname, "../..");

var emulator = new V86({
    bios: { url: path.join(V86_ROOT, "/bios/seabios.bin") },
    vga_bios: { url: path.join(V86_ROOT, "/bios/vgabios.bin") },
    autostart: true,
    memory_size: 512 * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    network_relay_url: "<UNUSED>",
    initial_state: { url: __dirname + "/../../images/arch_state.bin" },
    filesystem: {
        basefs: {
            url: path.join(V86_ROOT, "/images/fs.json"),
        },
        baseurl: path.join(V86_ROOT, "/images/arch/"),
    },
    screen_dummy: true,
});

emulator.bus.register("emulator-started", function()
{
    setTimeout(() => {
        emulator.serial0_send("cd nbench && ./nbench\n");
    }, 1000);
});

var line = "";

emulator.add_listener("serial0-output-char", function(chr)
{
    if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
    {
        return;
    }

    if(chr === "\n")
    {
        console.log("%s", line);
        line = "";
    }
    else
    {
        line += chr;
    }

    if(line === "* Trademarks are property of their respective holder.")
    {
        emulator.stop();
    }
});
