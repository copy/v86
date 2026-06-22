#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import url from "node:url";
import { execFileSync } from "node:child_process";
import { V86 } from "../../../build/libv86.mjs";

// TODO:
// - Timeout

console.log("Don't forget to run `make all` before running this script");

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const V86_ROOT = path.join(__dirname, "../../..");
var OUTPUT_FILE = path.join(V86_ROOT, "images/debian-state-base.bin");

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", handle_key);

var emulator = new V86({
    wasm_path: path.join(V86_ROOT, "build/v86.wasm"),
    bios: { url: path.join(V86_ROOT, "/bios/seabios.bin") },
    vga_bios: { url: path.join(V86_ROOT, "/bios/vgabios.bin") },
    autostart: true,
    memory_size: 1636 * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    network_relay_url: "<UNUSED>",
    bzimage: { url: path.join(V86_ROOT, "images/debian-bzImage") },
    initrd: { url: path.join(V86_ROOT, "images/debian-initrd") },
    hda: {
        url: path.join(V86_ROOT, "images/debian.img"),
        async: true,
        size: 5 * 1024 * 1024 * 1024,
    },
    // enable communication b/w JavaScript and v86 on serial port 1 (input) and 2 (output)
    uart1: true,
    uart2: true,
    // Remove unneeded security features since running in a sandbox (spectre_v2=off, pti=off).
    // Make state file half the size by setting "init_on_free=on", i.e. Linux overwrites freed memory with zeroes.
    // Set "rootflags=trans=virtio,cache=none --> doesn't help with FS cache"
    cmdline: "rw init=/bin/systemd root=/dev/sda console=ttyS0 spectre_v2=off pti=off init_on_free=on",
    screen_dummy: true,
});

console.log("Now booting, please stand by ...");

var boot_start = Date.now();
var serial_text = "";
let booted = false;
let saving = false;

emulator.add_listener("serial0-output-byte", function(byte)
{
    var c = String.fromCharCode(byte);
    process.stdout.write(c);

    serial_text += c;

    if(!booted && serial_text.includes("GUI_READY"))
    {
        console.error("\nBooted in %d", (Date.now() - boot_start) / 1000);
        booted = true;

        // Sync and drop caches: Makes it safer to change the filesystem as fewer files are rendered
        // Disable kernel logging with dmesg (drop_caches outputs things to ttyS0 even if run it on another port)
        emulator.serial0_send("sudo dmesg -n 1; sync; echo 3 | sudo tee /proc/sys/vm/drop_caches\n");

    }

    if(booted && !saving && serial_text.includes("GUI_READY"))
    {
        saving = true;
        console.error("\n\n'GUI_READY' signal received!");
        console.error("Waiting 240 seconds for GUI to fully render before saving state...");

        // Delay the state save by 240 seconds
        setTimeout(function() {
            console.error("\nTime is up! Saving state now...");
            emulator.save_state().then(function(s)
            {
                fs.writeFile(OUTPUT_FILE, new Uint8Array(s), function(e)
                {
                    if(e) throw e;
                    console.error("Saved as " + OUTPUT_FILE);
                    console.error("Compressing to " + OUTPUT_FILE + ".zst");
                    execFileSync("zstd", ["-19", "-f", OUTPUT_FILE, "-o", OUTPUT_FILE + ".zst"], { stdio: "inherit" });
                    stop();
                });
            });
        }, 240000);
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
