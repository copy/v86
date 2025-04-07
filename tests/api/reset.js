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

emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);
    serial_text += chr;

    if(serial_text.includes("Files send via emulator appear in /mnt/")) {
        serial_text = "";
        if(did_restart) {
            console.log("Ok");
            emulator.destroy();
        }
        else {
            console.log("Calling restart()");
            emulator.restart();
            did_restart = true;
        }
    }
});
