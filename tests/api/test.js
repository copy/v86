#!/usr/bin/env node

import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    fda: { url: __dirname + "/../../images/freedos722.img", async: true },
    network_relay_url: "<UNUSED>",
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: -641,
    disable_jit: +process.env.DISABLE_JIT,
});

setInterval(() => {
    console.log(emulator.screen_adapter.get_text_screen());
}, 500);
