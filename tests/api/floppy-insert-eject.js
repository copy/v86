#!/usr/bin/env node

import { setTimeout as pause } from "timers/promises";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    hda: { url: __dirname + "/../../images/msdos.img" },
    network_relay_url: "<UNUSED>",
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    log_level: 3,
    disable_jit: +process.env.DISABLE_JIT,
});

//const interval = setInterval(() => {
//    console.warn(emulator.screen_adapter.get_text_screen());
//}, 1000);

const timeout = setTimeout(() => {
    console.warn(emulator.screen_adapter.get_text_screen());
    throw new Error("Timeout");
}, 60 * 1000);

setTimeout(async () =>
{
    await emulator.wait_until_vga_screen_contains("C:\\> ");
    console.log("Got C:\\>");
    await pause(1000);
    emulator.keyboard_send_text("dir A:\n");
    await emulator.wait_until_vga_screen_contains("Abort, Retry, Fail?");
    console.log("Got Abort, Retry, Fail?");
    await pause(1000);
    emulator.keyboard_send_text("F");
    emulator.set_fda({ url: __dirname + "/../../images/freedos722.img" });
    emulator.keyboard_send_text("dir A:\n");
    await emulator.wait_until_vga_screen_contains("FDOS         <DIR>");
    console.log("Got FDOS");
    emulator.destroy();
    clearTimeout(timeout);
    //clearInterval(interval);
}, 1000);
