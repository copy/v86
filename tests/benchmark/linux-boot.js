#!/usr/bin/env node
"use strict";

const V86 = require("../../build/libv86.js").V86;
const print_stats = require("../../build/libv86.js").print_stats;
const fs = require("fs");
const path = require("path");
const V86_ROOT = path.join(__dirname, "../..");

const LOG_SERIAL = true;

if(false)
{
    var emulator = new V86({
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        cdrom: { url: __dirname + "/../../images/linux3.iso" },
        autostart: true,
        memory_size: 32 * 1024 * 1024,
    });
}
else
{
    var emulator = new V86({
        bios: { url: path.join(V86_ROOT, "/bios/seabios.bin") },
        vga_bios: { url: path.join(V86_ROOT, "/bios/vgabios.bin") },
        autostart: true,
        memory_size: 512 * 1024 * 1024,
        vga_memory_size: 8 * 1024 * 1024,
        network_relay_url: "<UNUSED>",
        bzimage_initrd_from_filesystem: true,
        cmdline: "rw init=/bin/systemd root=host9p console=ttyS0 spectre_v2=off pti=off",
        filesystem: {
            basefs: {
                url: path.join(V86_ROOT, "/images/debian-base-fs.json"),
            },
            baseurl: path.join(V86_ROOT, "/images/debian-9p-rootfs-flat/"),
        },
        screen_dummy: true,
    });
}

emulator.bus.register("emulator-started", function()
{
    console.error("Booting now, please stand by");
    start_time = Date.now();
});

var serial_text = "";
var start_time;

emulator.add_listener("serial0-output-char", function(c)
{
    if(LOG_SERIAL) process.stdout.write(c);

    serial_text += c;

    if(serial_text.endsWith("~% ") || serial_text.endsWith("root@localhost:~# "))
    {
        const end_time = Date.now();
        const elapsed = end_time - start_time;
        console.log("Done in %dms", elapsed);
        emulator.stop();

        const cpu = emulator.v86.cpu;
        console.log(print_stats.stats_to_string(cpu));
    }
});