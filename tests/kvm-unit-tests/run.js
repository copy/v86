#!/usr/bin/env node
"use strict";

var V86 = require("../../build/libv86.js").V86;
var fs = require("fs");

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
    memory_size: 256 * 1024 * 1024,
});

emulator.add_listener("serial0-output-char", function(chr)
{
    process.stdout.write(chr);
});

