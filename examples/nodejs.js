#!/usr/bin/env node
"use strict";

var fs = require("fs");
var V86 = require("../build/libv86.js").V86;

function readfile(path)
{
    return new Uint8Array(fs.readFileSync(path)).buffer;
}

var bios = readfile(__dirname + "/../bios/seabios.bin");
var linux = readfile(__dirname + "/../images/linux4.iso");

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

console.log("Now booting, please stand by ...");

var emulator = new V86({
    bios: { buffer: bios },
    cdrom: { buffer: linux },
    autostart: true,
});

emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);
    if(chr <= "~")
    {
        process.stdout.write(chr);
    }
});

process.stdin.on("data", function(c)
{
    if(c === "\u0003")
    {
        // ctrl c
        emulator.destroy();
        process.stdin.pause();
    }
    else
    {
        emulator.serial0_send(c);
    }
});
