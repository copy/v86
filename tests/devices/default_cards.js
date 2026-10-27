#!/usr/bin/env node

// The NE2000 and the SB16 as plugins (docs/modern-pc-devices-plan.md M1): a
// PC machine that names no cards gets them (src/net_adapters/ne2k/,
// src/audio_devices/sb16/; with TEST_RELEASE_BUILD=1 the built
// build/v86-ne2k.js and build/v86-sb16.js beside build/libv86.mjs), a plugin
// file that cannot be loaded fails the start naming it, a snapshot has format
// 8 and the cards' tagged slots, and a snapshot of the form before M1 (format
// 6, the cards' own states untagged in state[59] and state[61]) restores into
// the plugins as they are; slots of other cards are refused. The site's real
// saves: tests/api/site_states.mjs.

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const ROOT = __dirname + "/../../";
const BASE = {
    wasm_path: ROOT + "build/" + (TEST_RELEASE_BUILD ? "v86.wasm" : "v86-debug.wasm"),
    bios: { url: ROOT + "bios/seabios.bin" },
    vga_bios: { url: ROOT + "bios/vgabios.bin" },
    graphics_adapter: "bochs_vga",
    memory_size: 32 << 20,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    log_level: 0,
};

/** @return {!Promise<V86>} a machine up to SeaBIOS's "No bootable device", stopped */
async function boot(options = {})
{
    const emulator = new V86({ ...BASE, autostart: true, ...options });
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    await emulator.wait_until_vga_screen_contains("No bootable device.", { timeout_msec: 60000 });
    await emulator.stop();
    return emulator;
}

/** The snapshot's header and info (its state array, buffers by reference) */
function parse(snapshot)
{
    const header = new Int32Array(snapshot, 0, 4);
    const info_end = 16 + header[3];
    return { header, info: JSON.parse(new TextDecoder().decode(new Uint8Array(snapshot, 16, header[3]))), info_end };
}

/** The snapshot rewritten as before M1: format 6, the cards' slots untagged */
function as_before_m1(snapshot)
{
    const { info, info_end } = parse(snapshot);
    for(const slot of [59, 61]) info.state[slot] = info.state[slot][3];
    const json = new TextEncoder().encode(JSON.stringify(info));
    // (the buffers keep their place: the info block is padded to 4 bytes, as state.js writes it)
    const padded = json.length + 3 & ~3, old_padded = info_end - 16 + 3 & ~3;
    const rest = new Uint8Array(snapshot, 16 + old_padded);
    const out = new Uint8Array(16 + padded + rest.length);
    out.set(json, 16);
    out.fill(0x20, 16 + json.length, 16 + padded);
    out.set(rest, 16 + padded);
    const header = new Int32Array(out.buffer, 0, 4);
    header.set(new Int32Array(snapshot, 0, 4));
    header[1] = 6;
    header[2] = out.length;
    header[3] = padded;
    return out.buffer;
}

const plain = state => JSON.stringify(state, (key, value) => ArrayBuffer.isView(value) ? Array.from(value) : value);
const cards = emulator => [emulator.v86.cpu.devices.net.device["card"], emulator.v86.cpu.devices.audio.device["card"]];

// a plugin file that cannot be loaded: the start fails naming it (first, and
// without the other card: a plugin already registered in the process is not
// loaded again)
for(const [options, file] of [
    [{ net_device: { type: "ne2k", plugin_path: ROOT + "build/no-such-ne2k.js" }, audio_device: "none" }, /net_device "ne2k": cannot load .*no-such-ne2k\.js/],
    [{ net_device: { type: "none" }, audio_device: "sb16", audio_device_path: ROOT + "build/no-such-sb16.js" }, /audio_device "sb16": cannot load .*no-such-sb16\.js/],
])
{
    const emulator = new V86({ ...BASE, autostart: false, ...options });
    const error = await new Promise(resolve => emulator.add_listener("emulator-error", resolve));
    assert.match(String(error && error.message), file);
    await emulator.destroy();
}
console.log("PASS: a plugin file that cannot be loaded fails the start, named");

// the defaults: an NE2000 and an SB16, plugins
const first = await boot();
const [ne2k, sb16] = cards(first);
assert.ok(ne2k && sb16);
assert.equal(first.v86.cpu.devices.net.name, "ne2k");
assert.equal(first.v86.cpu.devices.audio.name, "sb16");
assert.equal(first.v86.cpu.devices.sb16, undefined, "no core SB16");
// (the NE2000 at its I/O BAR: a read of its reset port sets ISR.RST; the SB16's DSP version)
const io = first.v86.cpu.io;
const port = first.v86.cpu.devices.pci.config_read(first.v86.cpu.devices.net.pci_id, 0x10, 4) & 0xFFFC;
io.port_write8(port, 0x21);
io.port_read8(port + 0x1F);
assert.equal(io.port_read8(port + 0x07) & 0x80, 0x80, "the NE2000's reset in ISR");
io.port_write8(0x226, 1);
io.port_write8(0x226, 0);
assert.equal(io.port_read8(0x22A), 0xAA, "the DSP's reset answer");
io.port_write8(0x22C, 0xE1);
assert.deepEqual([io.port_read8(0x22A), io.port_read8(0x22A)], [4, 5], "DSP version 4.05");
console.log("PASS: a PC machine without net_device and audio_device has the NE2000 and the SB16 plugins");

// a snapshot: format 8, the cards' slots tagged
const snapshot = await first.save_state();
const { header, info } = parse(snapshot);
assert.equal(header[1], 8, "format 8");
assert.deepEqual([info.state[59][0], info.state[59][2], info.state[61][0], info.state[61][2]], ["net_adapter", "ne2k", "audio_device", "sb16"]);
const saved = [plain(ne2k.get_state()), plain(sb16.get_state())];
await first.destroy();
console.log("PASS: a snapshot has format 8 and the cards' tagged slots");

// as before M1 (format 6, untagged): the plugins read the cards' own states
// (the saved address too: a new NE2000 has a random one, and keeps it unless told otherwise)
for(const [label, state] of [["format 8", snapshot], ["before M1", as_before_m1(snapshot)]])
{
    const machine = await boot({ preserve_mac_from_state_image: true });
    await machine.restore_state(state);
    assert.deepEqual(cards(machine).map(card => plain(card.get_state())), saved, label + ": the cards as saved");
    await machine.destroy();
}
console.log("PASS: a snapshot of the form before M1 (format 6, untagged slots) restores into the plugins as it is");

// other cards: refused before anything changes
for(const [options, message] of [
    [{ net_device: { type: "e1000" } }, /with net_device: "ne2k", this one has "e1000"/],
    [{ net_device: { type: "none" } }, /with net_device: "ne2k", this one has "none"/],
    [{ audio_device: "hd_audio" }, /with audio_device: "sb16", this one has "hd_audio"/],
    [{ audio_device: "none" }, /with audio_device: "sb16", this one has "none"/],
])
{
    for(const state of [snapshot, as_before_m1(snapshot)])
    {
        const machine = await boot(options);
        await assert.rejects(machine.restore_state(state), message);
        await machine.destroy();
    }
}
console.log("PASS: the slots of other cards are refused, tagged or not");
