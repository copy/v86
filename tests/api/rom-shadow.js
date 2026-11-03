#!/usr/bin/env node

import url from "node:url";
import fs from "node:fs";
import assert from "node:assert/strict";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const boot_sector_path = __dirname + "/../../build/rom-shadow.bin";
if(!fs.existsSync(boot_sector_path))
{
    throw new Error("Missing " + boot_sector_path + ", build it with: make build/rom-shadow.bin");
}

// See rom-shadow.asm
const RESULTS = 0x600;
const DONE = 0x700;
const DONE_MAGIC = 0xA5;
const GO = 0x701;
const CHECKS = [
    { name: "byte store to 0xC2000", writable: false },
    { name: "dword store to 0xF0000", writable: false },
    { name: "read-modify-write of 0xC2010", writable: false },
    { name: "rep stosw to 0xC3000", writable: false },
    { name: "hot loop on 0xC2020", writable: false },
    { name: "store to conventional memory", writable: true },
    { name: "store to 0xC2030 with PAM1 write enabled", writable: true },
    { name: "store to 0xC2040 after restoring PAM1", writable: false },
    { name: "store to 0xE0000 (not locked by SeaBIOS)", writable: true },
];

const floppy = new Uint8Array(1440 * 1024);
floppy.set(fs.readFileSync(boot_sector_path));

const config = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    fda: { buffer: floppy.buffer },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
};

const timeout = setTimeout(() => {
    throw new Error("Timeout");
}, 120 * 1000);

async function wait_for_checks(emulator, label)
{
    while(emulator.read_memory(DONE, 1)[0] !== DONE_MAGIC)
    {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const results = emulator.read_memory(RESULTS, 2 * CHECKS.length);
    let failed = false;

    for(const [i, check] of CHECKS.entries())
    {
        const before = results[2 * i];
        const after = results[2 * i + 1];
        const writable = before !== after;
        const ok = writable === check.writable;
        failed ||= !ok;
        console.log("%s %s: %s: %s -> %s (%s)", ok ? "ok  " : "FAIL", label, check.name,
            before.toString(16), after.toString(16), writable ? "written" : "discarded");
    }

    assert(!failed, "rom shadow checks failed (" + label + ")");
}

const emulator = new V86(config);
await new Promise(resolve => emulator.bus.register("emulator-started", resolve));

await wait_for_checks(emulator, "boot");
const state = await emulator.save_state();

// the reset restores the power-on PAM settings, SeaBIOS must be able to unlock and lock again
emulator.write_memory([0], DONE);
emulator.restart();
await wait_for_checks(emulator, "reboot");
emulator.destroy();

// a fresh emulator starts with the power-on PAM settings, restoring must apply the saved ones
const restored = new V86({ ...config, initial_state: { buffer: state } });
await new Promise(resolve => restored.bus.register("emulator-started", resolve));
restored.write_memory([0], DONE);
restored.write_memory([1], GO);
await wait_for_checks(restored, "restored state");
restored.destroy();

clearTimeout(timeout);
console.log("Test passed");
