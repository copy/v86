#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });
const V86 = require("../../build/libv86-debug.js").V86;
const fs = require("fs");

// Random printable characters
const test_file = (new Uint8Array(512)).map(v => 0x20 + Math.random() * 0x5e);
const tests =
[
    {
        name: "Read Existing",
        start: () =>
        {
            emulator.serial0_send("cp /etc/profile /mnt/read-existing\n");
            emulator.serial0_send("echo start-capture; cat /etc/profile; echo done-read-existing\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-read-existing",
        end: capture =>
        {
            emulator.read_file("read-existing", function(err, data)
            {
                if(err)
                {
                    console.log("Reading read-existing failed: " + err);
                    process.exit(1);
                }
                const expected = capture;
                const actual = Buffer.from(data).toString().replace(/\n/g, '');
                if(actual !== expected)
                {
                    console.log("Fail: Incorrect data");
                    console.log("Expected:\n", expected);
                    console.log("Actual:\n", actual);
                    process.exit(1);
                }
            });
        },
    },
    {
        name: "Read New",
        start: () =>
        {
            emulator.serial0_send("dd if=/dev/zero of=/mnt/read-new bs=1k count=512\n");
            emulator.serial0_send("echo done-read-new\n");
        },
        end_trigger: "done-read-new",
        end: () =>
        {
            emulator.read_file("read-new", function(err, data)
            {
                if(err)
                {
                    console.log("Reading read-new failed: " + err);
                    process.exit(1);
                }
                if(data.length !== 512 * 1024)
                {
                    console.log("Fail: Incorrect size");
                    process.exit(1);
                }
                if(data.find(v => v !== 0))
                {
                    console.log("Fail: Incorrect data. Expected all zeros.");
                    process.exit(1);
                }
            });
        },
    },
    {
        name: "Write New",
        start: () =>
        {
            emulator.serial0_send("echo start-capture; cat /mnt/write-new; echo; echo done-write-new\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-write-new",
        end: capture  =>
        {
            const actual = capture;
            const expected = Buffer.from(test_file).toString().replace(/\n/g, '');
            if(actual !== expected)
            {
                console.log("Fail: Incorrect data");
                console.log("Expected:\n", expected);
                console.log("Actual:\n", actual);
                process.exit(1);
            }
        },
    },
];

let test_num = 0;

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
});

let ran_command = false;
let line = "";
let capturing = false;
let capture = "";

emulator.bus.register("emulator-started", function()
{
    console.log("Booting now, please stand by");
    emulator.create_file("write-new", test_file);
});

emulator.add_listener("serial0-output-char", function(chr)
{
    if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
    {
        return;
    }

    let new_line = "";
    if(chr === "\n")
    {
        new_line = line;
        console.log("Serial: %s", line);
        line = "";
    }
    else
    {
        line += chr;
    }

    if(!ran_command && line.endsWith("~% "))
    {
        ran_command = true;
        console.log("Starting: " + tests[0].name);
        tests[0].start();
    }
    else if(new_line === tests[test_num].capture_trigger)
    {
        capture = "";
        capturing = true;
    }
    else if(new_line === tests[test_num].end_trigger)
    {
        tests[test_num].end(capture);
        console.log("Passed: " + tests[test_num].name);

        test_num++;
        capture = "";
        capturing = false;

        if(test_num < tests.length)
        {
            console.log("Starting: " + tests[test_num].name);
            tests[test_num].start();
        }
        else
        {
            console.log("Tests finished");
            emulator.stop();
        }
    }
    else if(capturing)
    {
        capture += new_line;
    }
});
