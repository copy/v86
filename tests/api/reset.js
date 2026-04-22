#!/usr/bin/env node

import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

// This test checks that reset works

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const config = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: true },
    network_relay_url: "<UNUSED>",
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
};

const emulator = new V86(config);

let did_restart = false;
let serial_text = "";

const timeout = setTimeout(() => {
    console.log(serial_text);
    throw new Error("Timeout");
}, 60 * 1000);

emulator.add_listener("serial0-output-byte", async function(byte)
{
    var chr = String.fromCharCode(byte);
    process.stdout.write(chr);
    serial_text += chr;

    if(did_restart)
    {
        if(serial_text.endsWith("Files send via emulator appear in /mnt/"))
        {
            console.log("running echo");
            emulator.keyboard_send_text("echo fini''shed\n");

            await emulator.wait_until_vga_screen_contains("finished");
            console.log("Ok");
            emulator.destroy();
            clearTimeout(timeout);
        }
    }
    else
    {
        if(serial_text.endsWith("~% "))
        {
            emulator.keyboard_send_text("abc");
            setTimeout(() => {
                console.log("Calling restart()");
                emulator.restart();
            }, 500);
            serial_text = "";
            did_restart = true;
        }
    }
});
