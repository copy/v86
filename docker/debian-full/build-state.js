#!/usr/bin/env node
"use strict";

const path = require("path");

// TODO:
// - Timeout

console.log("Don't forget to run `make all` before running this script");

var fs = require("fs");
var V86 = require("./../../build/libv86.js").V86;

const V86_ROOT = path.join(__dirname, "../..");

var OUTPUT_FILE = path.join(V86_ROOT, "images/debian-state-base.bin");
var SCREEN_FILE = "/tmp/screen_debian_full.txt";

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

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

console.log("Now booting, please stand by ...");

var boot_start = Date.now();
var serial_text = "";

process.stdin.on("data", function(c)
{
    if(c === "\u0003")
    {
        // ctrl c
        process.exit();
    }
    else
    {
        emulator.serial0_send(c);
    }
});

emulator.add_listener("serial0-output-char", function(c)
{
    process.stdout.write(c);

    serial_text += c;

    if(serial_text.endsWith("root@localhost:~# "))
    {
        console.error("\nBooted in %d", (Date.now() - boot_start) / 1000);

        // wait a few seconds as the serial console finishes faster than the screen terminal

        setTimeout(function ()
            {
                emulator.save_state(function(err, s)
                    {
                        if(err)
                        {
                            throw err;
                        }

                        fs.writeFile(OUTPUT_FILE, new Uint8Array(s), function(e)
                            {
                                if(e) throw e;
                                console.error("Saved as " + OUTPUT_FILE);
                                emulator.stop();
                                setTimeout(() => process.exit(0), 5000);
                            });
                    });
            }, 5000);
    }
});

//function save_screen()
//{
//    var screen = emulator.screen_adapter.get_text_screen();
//    fs.writeFile(SCREEN_FILE, screen.join("\n"), function(e) { if(e) throw e; });
//}
//
//setInterval(save_screen, 1000);
