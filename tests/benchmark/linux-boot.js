#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const BENCH_COLLECT_STATS = +process.env.BENCH_COLLECT_STATS;
const { V86 } = await import(BENCH_COLLECT_STATS ? "../../src/main.js" : "../../build/libv86.mjs");

const V86_ROOT = path.join(__dirname, "../..");

const LOG_SERIAL = true;

if(true)
{
    var emulator = new V86({
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        cdrom: { url: __dirname + "/../../images/linux3.iso" },
        autostart: true,
        memory_size: 32 * 1024 * 1024,
        disable_jit: +process.env.DISABLE_JIT,
        log_level: 0,
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
        cmdline: "rw console=ttyS0 apm=off root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose mitigations=off audit=0 tsc=reliable nowatchdog init=/usr/bin/init-openrc",
        filesystem: {
            basefs: {
                url: path.join(V86_ROOT, "/images/fs.json"),
            },
            baseurl: path.join(V86_ROOT, "/images/arch/"),
        },
        disable_jit: +process.env.DISABLE_JIT,
        log_level: 0,
    });
}

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
        const end_time = Date.now();
        const elapsed = end_time - start_time;
        console.log("Done in %dms", elapsed);
        emulator.destroy();

        if(BENCH_COLLECT_STATS)
        {
            console.log(emulator.get_instruction_stats());
        }
    }
});
