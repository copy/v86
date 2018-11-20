#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;

var V86 = require(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.js`).V86;
var fs = require("fs");

var test_executable = new Uint8Array(fs.readFileSync(__dirname + "/test-jit"));

var emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
});

emulator.bus.register("emulator-started", function()
{
    console.error("Booting now, please stand by");
    emulator.create_file("test-jit", test_executable);
});

var ran_command = false;
var line = "";

emulator.add_listener("serial0-output-char", function(chr)
{
    if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
    {
        return;
    }

    if(chr === "\n")
    {
        var new_line = line;
        console.error("Serial: %s", line);
        line = "";
    }
    else
    {
        line += chr;
    }

    if(!ran_command && line.endsWith("~% "))
    {
        ran_command = true;
        emulator.serial0_send("chmod +x /mnt/test-jit\n");
        emulator.serial0_send("/mnt/test-jit 2>&1 | tee /mnt/result\n");
        emulator.serial0_send("echo test fini''shed\n");
    }

    if(new_line && new_line.includes("test finished"))
    {
        console.error("Done. Reading result ...");

        emulator.read_file("/result", function(err, data)
            {
                emulator.stop();
                if(err) throw err;
                let result = Buffer.from(data).toString();
                if(result !== "test_shared passed\ntest_consecutive_written passed\n")
                {
                    console.error("[!] Error. Result was:\n" + result);
                    process.exit(1);
                }
                else
                {
                    console.log("[+] Test passed");
                }
            });
    }

});
