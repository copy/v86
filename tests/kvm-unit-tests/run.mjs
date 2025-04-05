#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;

var { V86 } = await import(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.mjs`);

function readfile(path)
{
    return new Uint8Array(fs.readFileSync(path)).buffer;
}

function Loader(path)
{
    this.buffer = readfile(path);
    this.byteLength = this.buffer.byteLength;
}

Loader.prototype.load = function()
{
    this.onload && this.onload({});
};

var bios = readfile(__dirname + "/../../bios/seabios.bin");
var vga_bios = readfile(__dirname + "/../../bios/vgabios.bin");

var emulator = new V86({
    bios: { buffer: bios },
    vga_bios: { buffer: vga_bios },
    multiboot: new Loader(process.argv[2]),
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
