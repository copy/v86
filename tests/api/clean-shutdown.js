#!/usr/bin/env node

import url from "node:url";
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

// This test checks that calling emulator.destroy() will remove all event
// listeners, so that the nodejs process cleanly and automatically exits.

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

setTimeout(function()
    {
        console.error("Calling stop()");
        emulator.destroy();
        console.error("Called stop()");
    }, 3000);
