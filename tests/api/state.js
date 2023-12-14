#!/usr/bin/env node
"use strict";

process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;

var V86 = require(`../../build/${TEST_RELEASE_BUILD ? "libv86" : "libv86-debug"}.js`).V86;
const assert = require("assert").strict;
var fs = require("fs");

const config_async_cdrom = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: true },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    screen_dummy: true,
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

const config_sync_cdrom = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: false },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    screen_dummy: true,
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

const config_filesystem = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    filesystem: {},
    bzimage: { url: __dirname + "/../../images/buildroot-bzimage.bin" },
    cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
    network_relay_url: "<UNUSED>",
    screen_dummy: true,
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

const config_large_memory = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: true },
    autostart: true,
    memory_size: 2048 * 1024 * 1024,
    vga_memory_size: 512 * 1024 * 1024,
    network_relay_url: "<UNUSED>",
    screen_dummy: true,
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function screen_contains(emulator, text)
{
    const lines = emulator.screen_adapter.get_text_screen();
    return lines.some(line => line.startsWith(text));
}

async function run_test(name, config, done)
{
    const emulator = new V86(config);

    await sleep(2000);

    console.log("Saving: %s", name);
    const state = await emulator.save_state();

    await sleep(1000);

    console.log("Restoring: %s", name);
    await emulator.restore_state(state);

    do
    {
        await sleep(1000);
    }
    while(!screen_contains(emulator, "~% "));

    emulator.keyboard_send_text("echo -n test; echo passed\n");

    await sleep(1000);

    const lines = emulator.screen_adapter.get_text_screen();
    if(!screen_contains(emulator, "testpassed"))
    {
        console.warn("Failed: " + name);
        console.warn(lines.map(line => line.replace(/\x00/g, " ")));
        process.exit(1);
    }

    console.log("Done: %s", name);
    emulator.stop();
}

(async function() {
    await run_test("async cdrom", config_async_cdrom);
    await run_test("sync cdrom", config_sync_cdrom);
    await run_test("filesystem", config_filesystem);
    await run_test("large memory size", config_large_memory);
})();
