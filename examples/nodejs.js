#!/usr/bin/env node
"use strict";

var fs = require("fs");
var V86Starter = require("../build/libv86.js").V86Starter;

function readfile(path)
{
    return new Uint8Array(fs.readFileSync(path)).buffer;
}

var bios = readfile(__dirname + "/../bios/seabios.bin");
var linux = readfile(__dirname + "/../images/linux.iso");

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

var boot_start = Date.now();
var booted = false;

console.log("Now booting, please stand by ...");

var emulator = new V86Starter({
    bios: { buffer: bios },
    cdrom: { buffer: linux },
    autostart: true,
});

emulator.add_listener("serial0-output-char", function(chr)
{
    if(!booted)
    {
        var now = Date.now();
        console.log("Took %dms to boot", now - boot_start);
        booted = true;
    }

    process.stdout.write(chr);
});

process.stdin.on("data", function(c)
{
    if(c === "\u0003")
    {
        // ctrl c
        emulator.stop();
        process.stdin.pause();
    }
    else
    {
        emulator.serial0_send(c);
    }
});
