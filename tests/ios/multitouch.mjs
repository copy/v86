// Original N1 driver bootstrap and property discovery on owner-supplied files.
// This accepts the endpoint's protocol; touch frames are a separate milestone.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";
const [firmware, image, ...extra] = process.argv.slice(2);
if(!firmware || !image || extra.length) throw new Error("usage: multitouch.mjs firmware-directory flash.img");
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
        emulator.add_listener("emulator-loaded", ok); emulator.add_listener("emulator-error", fail);
    });
    const cpu = emulator.v86.cpu, spi = cpu.devices.apple_spi1, touch = cpu.devices.apple_multitouch;
    const exchange = spi.exchange, reports = new Set();
    let bulk = 0;
    spi.exchange = (byte, first, length) => {
        const result = exchange(byte, first, length);
        if(touch.position === touch.length)
        {
            if(touch.bulk && touch.loaded) bulk++;
            if(touch.packet[0] === 0xE6 && touch.packet[2] === 1) reports.add(touch.packet[1]);
        }
        return result;
    };
    const complete = () => touch.running && [0xD1, 0xD3, 0xD0, 0xA1, 0xD9].every(id => reports.has(id));
    const deadline = performance.now() + 300000;
    cpu.clock.resume();
    while(!complete() && !serial.includes("panic(cpu") && performance.now() < deadline)
    {
        for(let i = 0; i < 24; i++) cpu.run_cores();
        await new Promise(resolve => setImmediate(resolve));
    }
    if(complete())
        for(let i = 0; i < 24000; i++)
        {
            cpu.run_cores();
            if(i % 24 === 0) await new Promise(resolve => setImmediate(resolve));
        }
    assert.doesNotMatch(serial, /panic\(cpu|Killing device|Couldn't bootload/, serial.slice(-5000));
    assert.match(serial, /AppleMultitouchN1SPI: detected HBPP/);
    assert.match(serial, /downloaded \d+ bytes of firmware data/);
    assert.ok(bulk >= 1 && touch.loaded);
    assert.ok(complete(), "native driver read the interface and all five required device reports");
    assert.equal(cpu.devices.apple_gpio.mask[0] & 1 << 21, 0, "native driver enabled the touch interrupt");
    console.log("PASS: original N1 driver uploaded and acknowledged its own firmware through SPI1 DMA");
    console.log("PASS: original N1 register calibration, execution command, interface version and device-report discovery");
}
finally { await emulator.destroy(); }
