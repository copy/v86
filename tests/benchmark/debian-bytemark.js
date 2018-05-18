#!/usr/bin/env node
"use strict";

var V86 = require("../../build/libv86.js").V86;

var emulator = new V86({
    hda: { url: __dirname + "/../../images/debian-bench.img", async: true },
    initial_state: { url: __dirname + "/../../images/debian-state-bench.bin" },
    network_relay_url: "wss://127.0.0.1/",
    autostart: true,
    memory_size: 128 * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
});

emulator.bus.register("emulator-started", function()
{
    setTimeout(() => {
        emulator.serial0_send("cd bench && ./nbench\n");
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
