#!/usr/bin/env node

import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

var test_executable = new Uint8Array(fs.readFileSync(__dirname + "/test-i386"));

var emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    disable_jit: +process.env.DISABLE_JIT,
    log_level: +process.env.LOG_LEVEL || 0,
});

emulator.bus.register("emulator-started", function()
{
    emulator.create_file("test-i386", test_executable);
});

var ran_command = false;
var line = "";

let outfile = process.stdout;
if(process.argv[2])
{
    outfile = await fs.promises.open(process.argv[2], "w");
}

emulator.add_listener("serial0-output-byte", async function(byte)
{
    var chr = String.fromCharCode(byte);
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
    else if(chr >= " " && chr <= "~")
    {
        line += chr;
    }

    if(!ran_command && line.endsWith("~% "))
    {
        ran_command = true;
        emulator.serial0_send("chmod +x /mnt/test-i386\n");
        emulator.serial0_send("/mnt/test-i386 > /mnt/result\n");
        emulator.serial0_send("echo test fini''shed\n");
    }

    if(new_line && new_line.includes("test finished"))
    {
        console.error("Done. Reading result ...");

        const data = await emulator.read_file("/result");
        console.error("Got result, writing to stdout");

        outfile.write(Buffer.from(data));
        emulator.destroy();
    }
});
