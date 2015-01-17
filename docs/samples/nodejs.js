"use strict";

var fs = require("fs");
var V86Starter = require("../../build/libv86.js").V86Starter;

function readfile(path)
{
    return new Uint8Array(fs.readFileSync(path)).buffer;
}

var bios = readfile(__dirname + "/../../bios/seabios.bin");
var linux = readfile(__dirname + "/../../images/linux.iso");

var emulator = new V86Starter({
    bios: { buffer: bios },
    cdrom: { buffer: linux },
    autostart: true,
});

emulator.add_listener("serial0-output-char", function(chr)
{
    process.stdout.write(chr);
});

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

var state;

process.stdin.on("data", function(c)
{
    if(c === "\u0003")
    {
        // ctrl c
        process.exit();
    }
    else if(c === "\x1b\x4f\x51")
    {
        // f2
        emulator.save_state(function(err, s)
        {
            console.log("--- Saved ---");
            if(err)
            {
                throw err;
            }

            state = s;
        });
    }
    else if(c === "\x1b\x4f\x52")
    {
        // f3
        if(state)
        {
            console.log("--- Restored ---");
            emulator.restore_state(state);
        }
    }
    else
    {
        emulator.serial0_send(c);
    }
});
