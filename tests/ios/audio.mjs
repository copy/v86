// Native N90 audio-control initialization on owner-supplied firmware/media.
// This checks driver transactions and clock control, not PCM playback.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";

const [firmware, image, ...extra] = process.argv.slice(2);
if(!firmware || !image || extra.length) throw new Error("usage: audio.mjs firmware-directory flash.img");
const file = name => ({ url: path.resolve(firmware, name) });
const emulator = new V86({
    machine_type: "s5l8930", graphics_adapter: "none", autostart: false, log_level: 0,
    wasm_path: fileURLToPath(new URL("../../build/v86-arm64.wasm", import.meta.url)),
    ios: { kernelcache: file("kernelcache.n90.macho"), devicetree: file("DeviceTree.n90ap.bin"),
        nand: { url: path.resolve(image), size: fs.statSync(image).size } },
});
let serial = "";
emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
try
{
    await new Promise((ok, fail) => {
        emulator.add_listener("emulator-loaded", ok);
        emulator.add_listener("emulator-error", fail);
    });
    const cpu = emulator.v86.cpu, seen = new Set();
    const i2c = cpu.devices.apple_i2c0, transfer = i2c.write.bind(i2c);
    i2c.write = (offset, value) => {
        const bytes = i2c.fifo.slice();
        transfer(offset, value);
        if(offset !== 0x24 || !(value & 4) || (i2c.regs[3] & 0x30) !== 0x10) return;
        const slave = i2c.regs[0], reg = i2c.regs[4], writing = value & 1;
        if(slave === 0x39)
        {
            if(writing && reg === 1 && bytes[0] === 0x80) seen.add("Mikey reset");
            if(writing && reg === 4 && bytes[0] === 0x21) seen.add("Mikey configuration");
            if(!writing && reg === 12 && i2c.fifo[0] === 0) seen.add("disconnected headset");
        }
        if(slave === 0x4a)
        {
            if(!writing && reg === 5) seen.add("codec power read");
            if(writing && reg === 0x22) seen.add("codec gain write");
            if(writing && reg === 0x24) seen.add("codec output write");
        }
    };
    const i2s = cpu.devices.apple_i2s0, read = i2s.read.bind(i2s), write = i2s.write.bind(i2s);
    let stopped = false;
    i2s.write = (offset, value) => {
        write(offset, value);
        if(offset === 0 && !(value & 1)) stopped = true;
    };
    i2s.read = offset => {
        const value = read(offset);
        if(stopped && offset === 0 && (value & 3) === 2) seen.add("I2S clock stopped");
        return value;
    };
    const required = ["Mikey reset", "Mikey configuration", "disconnected headset", "codec power read",
        "codec gain write", "codec output write", "I2S clock stopped"];
    const ready = () => required.every(name => seen.has(name));
    const deadline = performance.now() + 180000;
    cpu.clock.resume();
    while(!ready() && !serial.includes("panic(cpu") && performance.now() < deadline)
    {
        for(let i = 0; i < 24; i++) cpu.run_cores();
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.doesNotMatch(serial, /panic\(cpu/, serial.slice(-3000));
    assert.ok(serial.includes("BSD root: disk0s1s1"), serial.slice(-1500));
    for(const name of required) assert.ok(seen.has(name), "missing native transaction: " + name);
    assert.doesNotMatch(serial, /could not reset Mikey|AppleCS42L61Audio: I2C register .* failed/);
    console.log("PASS: original Mikey reset, configuration and disconnected-headset detection");
    console.log("PASS: original CS42L61 power, gain and output control transactions");
    console.log("PASS: original I2S stop sequence observed the hardware acknowledgement");
}
finally { await emulator.destroy(); }
