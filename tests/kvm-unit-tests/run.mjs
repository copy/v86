#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

var emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    multiboot: { url: process.argv[2] },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
});

emulator.bus.register("emulator-started", function()
{
    emulator.v86.cpu.io.register_write_consecutive(0xF4, {},
        function(value)
        {
            console.log("Test exited with code " + value);
            process.exit(value);
        },
        function() {},
        function() {},
        function() {});
});

emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);
    process.stdout.write(chr);
});
