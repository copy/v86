#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });
const V86 = require("../../build/libv86-debug.js").V86;
const fs = require("fs");

const test_file = new Uint8Array(fs.readFileSync(__dirname + "/test-file"));
const tests =
[
    {
        name: "Read Existing",
        start: () =>
        {
            emulator.serial0_send("cp /etc/profile /mnt/read-existing\n");
            emulator.serial0_send("echo start-capture; base64 /etc/profile; echo done-read-existing\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-read-existing",
        end: expected =>
        {
            emulator.read_file("read-existing", function(err, data)
            {
                if(err)
                {
                    console.log("Reading read-existing failed: " + err);
                    process.exit(1);
                }
                const actual = Buffer.from(data).toString('base64');
                if(actual !== expected)
                {
                    console.log("Fail: Incorrect data");
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
                if(data.length < 512 * 1024)
                {
                    console.log("Fail: Incorrect size");
                    process.exit(1);
                }
                if(data.find(v => v !== 0))
                {
                    console.log("Fail: Incorrect data");
                    process.exit(1);
                }
            });
        },
    },
    {
        name: "Write New",
        start: () =>
        {
            emulator.serial0_send("echo start-capture; base64 /mnt/write-new; echo done-write-new\n");
        },
        capture_trigger: "start-capture",
        end_trigger: "done-write-new",
        end: actual  =>
        {
            const expected = Buffer.from(test_file).toString('base64');
            if(actual !== expected)
            {
                console.log("Fail: Incorrect data");
                process.exit(1);
            }
        },
    },
];

let test_num = 0;

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    hda: { url: __dirname + "/../../images/debian-bench.img" },
    autostart: true,
    memory_size: 512 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
});

let ran_command = false;
let line = "";
let capturing = true;
let capture = "";

emulator.bus.register("emulator-started", function()
{
    console.log("Booting up... Note: the debian image takes a while to boot");
    emulator.create_file("write-new", test_file);
});

emulator.add_listener("serial0-output-char", function(chr)
{
    if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
    {
        return;
    }

    let new_line;
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

    if(capturing)
    {
        capture += chr;
    }

    if(!ran_command && line.endsWith("~# "))
    {
        ran_command = true;
        emulator.serial0_send("mount host9p -t 9p /mnt\n");

        console.log("Starting: " + tests[0].name);
        tests[0].start();
    }

    if(new_line === tests[test_num].capture_trigger)
    {
        capture = "";
        capturing = true;
    }

    if(new_line === tests[test_num].end_trigger)
    {
        const capture_result = capture.slice(0, -1 - tests[test_num].end_trigger.length);
        console.log("Captured:\n" + capture_result);

        tests[test_num].end(capture_result);
        console.log("Passed: " + tests[test_num].name);

        test_num++;
        capture = "";
        capturing = false;

        if(test_num > tests.length)
        {
            console.log("Tests finished");
            emulator.stop();
            process.exit(0);
        }

        console.log("Starting: " + tests[test_num].name);
        tests[test_num].start();
    }
});
