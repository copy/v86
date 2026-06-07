#!/usr/bin/env node

import assert from "assert/strict";
import fs from "node:fs";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const SHOW_LOGS = false;

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    bzimage: { url: __dirname + "/../../images/buildroot-bzimage68.bin" },
    autostart: true,
    memory_size: 512 * 1024 * 1024,
    acpi: true,
    cmdline: [
        "console=ttyS0",
        "audit=0",
    ].join(" "),
    disable_jit: +process.env.DISABLE_JIT,
    log_level: SHOW_LOGS ? 0x400000 : 0,
    virtio_console: true,
});

let line = "";
let sent_command = false;

emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);

    process.stdout.write(chr);

    if(chr === "\n")
    {
        line = "";
    }
    else
    {
        line += chr;
    }

    // TODO: use better prompt detection once it's configured to not print colours
    if(!sent_command && line.endsWith("~%"))
    {
        sent_command = true;
        emulator.serial0_send("lspci -vv; echo ping > /dev/hvc0\n");
    }

    if(line.endsWith("pong"))
    {
        console.log("\nTest passed");
        emulator.destroy();
    }
});

let got_output = false;

emulator.add_listener("virtio-console0-output-bytes", function(bytes)
{
    if(!got_output)
    {
        got_output = true;
        console.log("From virtio console:", String.fromCharCode.apply(String, bytes));
        emulator.serial0_send("cat /dev/hvc0\n");
        setTimeout(() => {
            emulator.bus.send("virtio-console0-input-bytes", Uint8Array.from(Buffer.from("pong\n")));
        }, 5000);
    }
});
