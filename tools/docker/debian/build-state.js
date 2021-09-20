#!/usr/bin/env node
"use strict";

const path = require("path");

// TODO:
// - Timeout

console.log("Don't forget to run `make all` before running this script");

var fs = require("fs");
var V86 = require("./../../../build/libv86.js").V86;

const V86_ROOT = path.join(__dirname, "../../..");

var OUTPUT_FILE = path.join(V86_ROOT, "images/debian-state-base.bin");

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", handle_key);

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
let booted = false;

emulator.add_listener("serial0-output-char", function(c)
{
    process.stdout.write(c);

    serial_text += c;

    if(!booted && serial_text.endsWith("root@localhost:~# "))
    {
        console.error("\nBooted in %d", (Date.now() - boot_start) / 1000);
        booted = true;

        // sync and drop caches: Makes it safer to change the filesystem as fewer files are rendered
        emulator.serial0_send("sync;echo 3 >/proc/sys/vm/drop_caches\n");

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
                                stop();
                            });
                    });
            }, 10 * 1000);
    }
});

function handle_key(c)
{
    if(c === "\u0003")
    {
        // ctrl c
        stop();
    }
    else
    {
        emulator.serial0_send(c);
    }
}

function stop()
{
    emulator.stop();
    process.stdin.pause();
}
