#!/usr/bin/env node

// This test checks that restoring a state restores the SB16's sampling rate
// for the speaker too, and drops the samples of the discarded timeline.

import assert from "assert/strict";

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { buffer: new Uint8Array(0x10000).fill(0xF4).buffer },
    // (without a primary drive, restoring before PCI enumeration hits a
    // separate bug in PCI.set_state)
    hda: { buffer: new ArrayBuffer(1024 * 1024) },
    memory_size: 16 * 1024 * 1024,
    autostart: false,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));

// DSP command 0x41: set the output sampling rate
function set_sampling_rate(rate)
{
    for(const byte of [0x41, rate >> 8, rate & 0xFF])
    {
        emulator.v86.cpu.io.port_write8(0x22C, byte);
    }
}

let rate;
emulator.add_listener("dac-tell-sampling-rate", value => { rate = value; });

set_sampling_rate(44100);
assert.equal(rate, 44100);
const state = await emulator.save_state();

set_sampling_rate(11025);
// (the plugin's card: src/audio_devices/sb16/plugin.js)
const sb16 = emulator.v86.cpu.devices.audio.device["card"];
sb16.dac_buffers[0].push(0.5);
sb16.dac_buffers[1].push(0.5);

await emulator.restore_state(state);
assert.equal(rate, 44100, "the speaker hears the restored sampling rate");
assert.equal(sb16.dac_buffers[0].length + sb16.dac_buffers[1].length, 0, "no samples of the discarded timeline");

emulator.destroy();
console.log("Done");
