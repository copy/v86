// Owner-supplied 10B329 exercises its original SPI driver and N1 probe.
// There is no touch endpoint yet: the probe must receive the open bus,
// finish its PIO transactions, and decline the absent peripheral cleanly.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";

const [firmware, image, ...extra] = process.argv.slice(2);
if(!firmware || !image || extra.length) throw new Error("usage: spi.mjs firmware-directory flash.img");
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
    const cpu = emulator.v86.cpu, spi = cpu.devices.apple_spi1, sent = [], received = [];
    let irq = false, acknowledged = false;
    spi.exchange = byte => { sent.push(byte); return 0xff; };
    const read = spi.read.bind(spi), write = spi.write.bind(spi);
    spi.read = offset => {
        if(cpu.devices.apple_vic.lines[0] & (1 << 30)) irq = true;
        const value = read(offset);
        if(offset === 0x20) received.push(value);
        return value;
    };
    spi.write = (offset, value) => {
        write(offset, value);
        if(offset === 8 && sent.length && received.length === sent.length) acknowledged = true;
    };
    const marker = /AppleMultitouchN1SPI: Could not detect HBPP\. Returning false from finishStarting\(\)/;
    const deadline = performance.now() + 180000;
    cpu.clock.resume();
    while(!marker.test(serial) && !serial.includes("panic(cpu") && performance.now() < deadline)
    {
        for(let i = 0; i < 24; i++) cpu.run_cores();
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.doesNotMatch(serial, /panic\(cpu/, serial.slice(-3000));
    assert.match(serial, /BSD root: disk0s1s1/);
    assert.match(serial, /AppleMultitouchN1SPI: successfully started/);
    assert.match(serial, marker);
    assert.deepEqual(sent.slice(0, 2), [0x19, 0xc1], "native N1 wake command");
    assert.ok(sent.length >= 18 && (sent.length - 2) % 16 === 0, "complete 16-byte native probe attempts");
    for(let at = 2; at < sent.length; at += 16)
    {
        assert.equal(sent[at], 0x1a);
        assert.equal(sent[at + 1], 0xa1);
        for(let i = 2; i < 16; i++) assert.equal(sent[at + i], i & 1 ? 0xe1 : 0x18);
    }
    assert.equal(received.length, sent.length);
    assert.ok(received.every(byte => byte === 0xff));
    assert.ok(irq && acknowledged, "native handler drained the receive FIFO and acknowledged completion");
    assert.equal(spi.rx.length, 0);
    console.log("PASS: original SPI1 clock lookup, controller start and N1 driver matching");
    console.log("PASS: original N1 probe completed full-duplex PIO through VIC interrupt 30");
    console.log("PASS: unconnected touch endpoint returned an open bus and was declined cleanly");
}
finally { await emulator.destroy(); }
