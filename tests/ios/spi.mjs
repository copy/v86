// Owner-supplied 10B329 exercises its original SPI driver and N1 probe.
// The default probe declines an open bus. --dma supplies only an idle
// bootloader status to exercise firmware transport, not a touch endpoint.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "../../src/main.js";

const [firmware, image, ...extra] = process.argv.slice(2);
const checkDMA = extra.length === 1 && extra[0] === "--dma";
if(!firmware || !image || extra.length && !checkDMA) throw new Error("usage: spi.mjs firmware-directory flash.img [--dma]");
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
    const cpu = emulator.v86.cpu, spi = cpu.devices.apple_spi1, dma = cpu.devices.apple_cdma, sent = [], received = [];
    let irq = false, acknowledged = false;
    let bulk = 0, phase = 0, head = 0, cursor = false, bulkComplete = false;
    spi.exchange = byte => {
        if(checkDMA && spi.regs[1] & 0x40) bulk++;
        else sent.push(byte);
        return checkDMA ? (phase++ & 1 ? 0xe1 : 0x18) : 0xff;
    };
    if(checkDMA)
    {
        const read = dma.read.bind(dma), write = dma.write.bind(dma);
        dma.read = offset => {
            const value = read(offset);
            if(offset === 0x12014 && bulk && value !== head) cursor = true;
            return value;
        };
        dma.write = (offset, value) => {
            if(offset === 0x12014) head = value;
            write(offset, value);
        };
    }
    const read = spi.read.bind(spi), write = spi.write.bind(spi);
    spi.read = offset => {
        if(cpu.devices.apple_vic.lines[0] & (1 << 30)) irq = true;
        const value = read(offset);
        if(offset === 0x20) received.push(value);
        if(checkDMA && offset === 8 && cursor && bulk) bulkComplete = true;
        return value;
    };
    spi.write = (offset, value) => {
        write(offset, value);
        if(offset === 8 && sent.length && received.length === sent.length) acknowledged = true;
    };
    const marker = /AppleMultitouchN1SPI: Could not detect HBPP\. Returning false from finishStarting\(\)/;
    const deadline = performance.now() + (checkDMA ? 300000 : 180000);
    cpu.clock.resume();
    while(!(checkDMA ? bulkComplete : marker.test(serial)) && !serial.includes("panic(cpu") && performance.now() < deadline)
    {
        for(let i = 0; i < 24; i++) cpu.run_cores();
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.doesNotMatch(serial, /panic\(cpu/, serial.slice(-3000));
    assert.match(serial, /BSD root: disk0s1s1/);
    assert.match(serial, /AppleMultitouchN1SPI: successfully started/);
    if(checkDMA)
    {
        assert.match(serial, /AppleMultitouchN1SPI: detected HBPP/);
        assert.ok(bulk > 16384, "original driver streamed its firmware through transmit DMA");
        assert.ok(cursor && bulkComplete, "native handler retired its descriptor ring and completed the SPI transaction");
        assert.equal(spi.rx.length, 0);
        console.log("PASS: original N1 probe accepted the diagnostic bootloader status");
        console.log("PASS: original SPI1 firmware transmit DMA, application-CPU IRQ and descriptor callback completion");
        console.log("Firmware execution, handshake and touch input are not tested by this diagnostic endpoint");
    }
    else
    {
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
}
finally { await emulator.destroy(); }
