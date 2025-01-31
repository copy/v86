#!/usr/bin/env node
"use strict";

const BENCH_COLLECT_STATS = +process.env.BENCH_COLLECT_STATS;

const V86 = require(`../../build/${BENCH_COLLECT_STATS ? "libv86-debug" : "libv86"}.js`).V86;
const print_stats = require("../../build/libv86.js").print_stats;
const fs = require("fs");
const path = require("path");
const V86_ROOT = path.join(__dirname, "../..");

const LOG_SERIAL = true;


var emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux3.iso" },
    autostart: true,
    memory_size: 1024 * 1024 * 1024,
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
});


emulator.bus.register("emulator-started", function()
{
    console.log("Booting now, please stand by");
    start_time = Date.now();
});

var serial_text = "";
var start_time;

emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);
    if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
    {
        return;
    }

    if(LOG_SERIAL) process.stdout.write(chr);

    serial_text += chr;

    if(serial_text.endsWith("~% ") || serial_text.endsWith("root@localhost:~# "))
    {
        console.log("Creating snapshots");
        const start_time = Date.now();
        for(var i = 0; i < 10; ++i) emulator.save_state();
        const end_time = Date.now();
        const elapsed = end_time - start_time;
        console.log("Done in %dms", elapsed);
        emulator.destroy();

        if(BENCH_COLLECT_STATS)
        {
            const cpu = emulator.v86.cpu;
            console.log(print_stats.stats_to_string(cpu));
        }
    }
});
