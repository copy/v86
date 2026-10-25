#!/usr/bin/env node

// This test checks the SB16's 16-bit DMA playback: the address of a buffer in
// an odd 64 KiB page (the 16-bit channels count words, and the page register's
// bit 0 is unused), and a stop by masking the channel, as Windows XP's driver
// does (D9, exit auto-init, and the mask at once: reading on played the
// buffer's end again, the folder-click sound up to 8 times).

import assert from "assert/strict";

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { buffer: new Uint8Array(0x10000).fill(0xF4).buffer },
    hda: { buffer: new ArrayBuffer(1024 * 1024) },
    memory_size: 16 * 1024 * 1024,
    autostart: false,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));

const io = emulator.v86.cpu.io;
const dma = emulator.v86.cpu.devices.dma;

let samples = [];
emulator.add_listener("dac-send-data", ([left, right]) => { samples.push(...left, ...right); });

function dsp(...bytes)
{
    for(const byte of bytes) io.port_write8(0x22C, byte);
}

// the second controller's channel 5: mode, word address, page, words - 1
function program_channel5(mode, word_address, page, words)
{
    io.port_write8(0xD4, 0x05);
    io.port_write8(0xD8, 0);
    io.port_write8(0xD6, mode);
    io.port_write8(0xC4, word_address & 0xFF);
    io.port_write8(0xC4, word_address >> 8);
    io.port_write8(0x8B, page);
    io.port_write8(0xC6, words - 1 & 0xFF);
    io.port_write8(0xC6, words - 1 >> 8);
}

function fill16(address, words, value)
{
    emulator.write_memory(new Uint8Array(new Int16Array(words).fill(value).buffer), address);
}

// a buffer at 0x30000: page 2, word address 0x8000 (byte address bit 16 from the word address)
fill16(0x30000, 1024, 0x4000);
program_channel5(0x49, 0x8000, 0x02, 1024);
dsp(0xB0, 0x10, 1023 & 0xFF, 1023 >> 8);
io.port_write8(0xD4, 0x01);
for(let i = 0; i < 8; i++) emulator.bus.send("dac-request-data");
assert.equal(samples.length, 2 * 1024, "the whole buffer played, mono on both channels");
assert.ok(samples.every(s => Math.abs(s - 0.5) < 0.001), "the samples of 0x30000, not 0x20000's zeros");
console.log("PASS: a 16-bit buffer in an odd 64 KiB page");

// Windows XP's sounds: 16 KiB auto-init buffer, 128 KiB DSP block, stopped by D9 and the mask
samples = [];
fill16(0x8000, 8192, 0x2000);
program_channel5(0x59, 0x4000, 0, 8192);
dsp(0xB6, 0x30, 0xFF, 0xFF);
io.port_write8(0xD4, 0x01);
for(let i = 0; i < 3; i++) emulator.bus.send("dac-request-data");
assert.equal(samples.length, 3 * 1024, "three blocks of 2 KiB played");
dsp(0xD9);
io.port_write8(0xD4, 0x05);
const count = dma.channel_count[5];
samples = [];
for(let i = 0; i < 16; i++) emulator.bus.send("dac-request-data");
assert.equal(samples.length, 0, "a masked channel delivers no more samples");
assert.equal(dma.channel_count[5], count, "and its count stays");
console.log("PASS: masking the channel stops the sound");

emulator.destroy();
console.log("Done");
