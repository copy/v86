#!/usr/bin/env node

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const config_async_cdrom = {
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: true },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    filesystem: {},
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

const config_sync_cdrom = {
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: false },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    filesystem: {},
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

const config_filesystem = {
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    filesystem: {},
    bzimage: { url: __dirname + "/../../images/buildroot-bzimage68.bin" },
    cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
    network_relay_url: "<UNUSED>",
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

const config_large_memory = {
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: true },
    autostart: true,
    memory_size: 2048 * 1024 * 1024,
    // (the most vram_size allows, MAX_VRAM_SIZE in src/graphics_adapter.js)
    vram_size: 256 * 1024 * 1024,
    network_relay_url: "<UNUSED>",
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function run_test(name, config, done)
{
    const emulator = new V86(config);

    await sleep(2000);

    console.log("Saving: %s", name);
    const before_save = await emulator.get_diagnostics();
    const state = await emulator.save_state();

    await sleep(1000);

    console.log("Restoring: %s", name);
    await emulator.restore_state(state);

    const booted = await emulator.wait_until_vga_screen_contains("~% ", { timeout_msec: 120000 });
    if(!booted)
    {
        console.error("Timed out after restoring: " + name);
        console.error(JSON.stringify({ before_save, after_restore: await emulator.get_diagnostics() }));
        console.error(emulator.screen_adapter.get_text_screen());
        emulator.destroy();
        throw new Error("Guest did not boot after restoring " + name);
    }
    await sleep(1000);

    emulator.keyboard_send_text("echo -n test; echo passed\n");
    const responded = await emulator.wait_until_vga_screen_contains("testpassed", { timeout_msec: 10000 });
    if(!responded)
    {
        console.warn("Failed: " + name);
        const lines = emulator.screen_adapter.get_text_screen();
        console.warn(lines.map(line => line.replace(/\x00/g, " ")));
        process.exit(1);
    }

    console.log("Done: %s", name);
    emulator.destroy();
}

// Before the BIOS has enumerated PCI (there is none here), the IDE controller
// of a machine without a primary drive reports I/O BARs for the holes in its
// pci_bars
async function run_test_before_pci_enumeration()
{
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        bios: { buffer: new Uint8Array(0x10000).fill(0xF4).buffer },
        memory_size: 16 * 1024 * 1024,
        autostart: false,
        log_level: 0,
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));

    console.log("Saving and restoring: before PCI enumeration");
    await emulator.restore_state(await emulator.save_state());

    console.log("Done: before PCI enumeration");
    emulator.destroy();
}

// The UART's receive queue belongs to the snapshot: Linux's 8250 driver
// sizes the FIFO by looping 256 bytes back, and a restore that kept the
// queue of the timeline it discards handed them to the console (^\ killed
// init, the sync cdrom case failing now and then)
async function run_test_uart_queue()
{
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        bios: { buffer: new Uint8Array(0x10000).fill(0xF4).buffer },
        memory_size: 16 * 1024 * 1024,
        autostart: false,
        log_level: 0,
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    const uart = emulator.v86.cpu.devices.uart0;

    console.log("Saving and restoring: the UART's receive queue");
    uart.data_received(0x41);
    uart.data_received(0x42);
    const state = await emulator.save_state();
    uart.input.length = 0;
    for(let byte = 0; byte < 256; byte++) uart.data_received(byte);
    await emulator.restore_state(state);
    assert.deepEqual(uart.input, [0x41, 0x42], "the queue at the save");

    console.log("Done: the UART's receive queue");
    emulator.destroy();
}

(async function() {
    await run_test_before_pci_enumeration();
    await run_test_uart_queue();
    await run_test("async cdrom", config_async_cdrom);
    await run_test("sync cdrom", config_sync_cdrom);
    await run_test("filesystem", config_filesystem);
    await run_test("large memory size", config_large_memory);
})();
