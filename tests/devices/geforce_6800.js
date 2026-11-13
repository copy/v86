#!/usr/bin/env node
// Exercise the real PCI/MMIO map, memory-backed VRAM and snapshot serializer.
import assert from "node:assert/strict";
import { V86 } from "../../src/main.js";
import { NVTrace } from "../../src/graphics_adapters/geforce_6800/nv_trace.js";

const root = new URL("../../", import.meta.url).pathname;
assert.throws(() => new V86({ graphics_adapter: "geforce_6800", vram_size: 64 << 20 }), /128 or 256 MiB/);
const vm = new V86({
    graphics_adapter: "geforce_6800", vram_size: 128 << 20, memory_size: 32 << 20,
    bios: { url: root + "bios/seabios.bin" },
    net_device: { type: "none" }, disable_speaker: true, autostart: true, log_level: 0,
});
try
{
    await new Promise((resolve, reject) => {
        vm.add_listener("emulator-ready", resolve); vm.add_listener("emulator-error", reject);
    });
    await vm.wait_until_vga_screen_contains("No bootable device.", { timeout_msec: 30000 });
    await vm.stop();
    const cpu = vm.v86.cpu, io = cpu.io, nv = cpu.devices.graphics_adapter.device["nv"];
    const bdf = cpu.devices.graphics_adapter.pci_id;
    const config = offset => { io.port_write32(0xCF8, 0x80000000 | bdf << 8 | offset); return io.port_read32(0xCFC) >>> 0; };
    const pci_write = (offset, value) => { io.port_write32(0xCF8, 0x80000000 | bdf << 8 | offset); io.port_write32(0xCFC, value); };
    const read = addr => (cpu.read8(addr) | cpu.read8(addr + 1) << 8 | cpu.read8(addr + 2) << 16 | cpu.read8(addr + 3) << 24) >>> 0;
    const write = (addr, value) => { for(let i = 0; i < 4; i++) cpu.write8(addr + i, value >>> (8 * i) & 255); };
    assert.equal(config(0), 0x004510DE);
    assert.equal(config(8), 0x030000A1);
    assert.equal(config(0x34) & 255, 0x60);
    assert.equal(config(0x60) & 0xFFFF, 1, "PM capability, no AGP in chain");
    let mmio = config(0x10) & ~15;
    const fb = config(0x14) & ~15, ramin = config(0x18) & ~15;
    assert.equal(config(0x14) & 15, 8, "prefetchable VRAM");
    for(const [offset, mask] of [[0x10, 0xFF000000], [0x14, 0xF8000008], [0x18, 0xFF000000]])
    {
        const address = config(offset); pci_write(offset, -1);
        assert.equal(config(offset), mask); pci_write(offset, address);
    }
    assert.equal(read(mmio), 0x040500A1);
    write(mmio + 0x3304, 0);
    assert.equal(read(mmio + 0x3304), 3, "NV40 CACHE1 UNK104 is read-only and returns 3");
    assert.equal(read(mmio + 0x10020C), 128 << 20);
    assert.equal(read(mmio + 0x1800), config(0), "PBUS config mirror");
    assert.equal(read(mmio + 0x300000), 0, "PROM disabled until ROM BAR enable");
    pci_write(0x30, config(0x30) | 1);
    assert.equal(read(mmio + 0x300000) & 0xFFFF, 0xAA55, "PROM exposes the selected adapter ROM");
    assert.equal(cpu.read8(0xC0000 + 0x36), nv.machine.handle["vga_bios"]()[0x36]);
    write(mmio + 0x1800, 0x11223344);
    assert.equal(config(0), 0x004510DE, "mirror retains PCI readonly identity");
    write(mmio + 0x700120, 0x12345678);
    assert.equal(read(ramin + 0x120), 0x12345678, "BAR2 aliases PRAMIN");
    assert.equal(read(fb + (128 << 20) - (1 << 20) + 0x120), 0x12345678, "RAMIN lives in VRAM");
    write(ramin + 0x124, 0xAABBCCDD);
    assert.equal(read(mmio + 0x700124), 0xAABBCCDD);
    vm.v86.cpu.devices.graphics_adapter.device["nvlog"](true);
    write(mmio + 0x100240, 0xBADC0FFE);
    assert.equal(read(mmio + 0x100240), 0xBADC0FFE);
    const report = vm.v86.cpu.devices.graphics_adapter.device["nvtrace"]();
    assert(report.events.some(e => !e.implemented && e.offset === 0x100240));
    const trace = new NVTrace(2); trace.enabled = true;
    for(let i = 0; i < 5; i++) trace.record("mmio", 0, 4, false, i, true);
    assert.equal(trace.report().events.length, 2);
    assert.equal(trace.report().dropped, 3);
    assert.equal(trace.report().counts[0][1], 5);
    assert.deepEqual(trace.report().events.map(e => e.value), [3, 4], "ring retains the latest accesses in order");
    for(let i = 0; i < 10; i++) trace.record("mmio", i + 4, 4, false, 0, false);
    assert.equal(trace.report().counts.length, 2, "the summary also has a memory bound");
    assert.equal(trace.report().untracked, 9);
    console.log("PASS: NV40 PCI identity, BAR sizing, RAMIN aliases and bounded tracing");

    pci_write(0x10, 0xD0000000);
    mmio = 0xD0000000;
    assert.equal(read(mmio), 0x040500A1, "BAR relocation reaches the device");
    const command = config(4);
    pci_write(4, command & ~2);
    assert.equal(read(mmio), 0xFFFFFFFF, "PCI memory decode disabled");
    pci_write(4, command);
    assert.equal(read(mmio), 0x040500A1);
    write(mmio + 0x1804, command & ~2);
    assert.equal(config(4) & 2, 0, "PBUS command write goes through PCI core");
    assert.equal(read(mmio), 0xFFFFFFFF);
    pci_write(4, command);
    console.log("PASS: BAR relocation and PCI decode through CF8 and PBUS");

    write(mmio + 0x140, 2); write(mmio + 0x100, 0x80000000);
    assert.equal(read(mmio + 0x100), 0x80000000);
    write(mmio + 0x100, 0);
    assert.equal(read(mmio + 0x100), 0);
    nv.registers.set(0x2100, 0x1010);
    write(mmio + 0x2140, 0xFFFFFFFF);
    assert.equal(read(mmio + 0x100), 0x100);
    cpu.write8(mmio + 0x2101, 0x10);
    assert.equal(read(mmio + 0x2100), 0x10, "byte W1C does not clear adjacent status");

    const real_now = nv.machine.now;
    let now = 1000;
    nv.machine.now = () => now;
    nv.timer_epoch = now; nv.timer_value = 0;
    write(mmio + 0x9200, 1); write(mmio + 0x9210, 1);
    now++;
    assert.equal(read(mmio + 0x9400), 1000000);
    write(mmio + 0x9210, 2);
    now++;
    assert.equal(read(mmio + 0x9400), 3000000, "ratio change preserves accumulated time");
    write(mmio + 0x9420, 5000000);
    now += 0.5; nv.timer();
    assert.equal(read(mmio + 0x9100), 0);
    now += 0.5; nv.timer();
    assert.equal(read(mmio + 0x9100), 1, "alarm latches at its deadline");
    write(mmio + 0x9140, 1);
    assert.equal(read(mmio + 0x100) & (1 << 20), 1 << 20);
    write(mmio + 0x9100, 1);
    assert.equal(read(mmio + 0x100) & (1 << 20), 0);
    write(mmio + 0x9200, 0); const frozen = read(mmio + 0x9400); now += 100;
    assert.equal(read(mmio + 0x9400), frozen, "zero divisor stops the timer");
    nv.machine.now = real_now;
    nv.timer_epoch = real_now.call(nv.machine); nv.timer_value = frozen;
    console.log("PASS: PTIMER clock ratios, stopped clock, alarms and interrupt acknowledgement");

    const crtc = (index, value) => io.port_write16(0x3D4, index | value << 8);
    const crtc_read = index => { io.port_write8(0x3D4, index); return io.port_read8(0x3D5); };
    crtc(0x28, 3); assert.equal(crtc_read(0x28), 0, "extended CRTC is locked at reset");
    crtc(0x1F, 0x57); assert.equal(crtc_read(0x1F), 3);
    for(const [index, value] of [[1, 0], [0x12, 1], [7, 0], [0x25, 0], [0x41, 0], [0x13, 4], [0x28, 3]]) crtc(index, value);
    assert.equal(nv.display.mode().width, 8);
    write(fb + 0x2000, 0x00112233); write(fb + 0x3000, 0x00445566);
    write(mmio + 0x600800, 0x2000); nv.display.on_vblank(); nv.display.render();
    assert.deepEqual([...nv.display.pixels.data.subarray(0, 4)], [0x11, 0x22, 0x33, 255]);
    write(mmio + 0x600800, 0x3000); nv.display.render();
    assert.equal(nv.display.pixels.data[0], 0x11, "page flip waits for vblank");
    nv.display.on_vblank(); nv.display.render();
    assert.equal(nv.display.pixels.data[0], 0x44);
    crtc(0x13, 2); crtc(0x28, 2); write(mmio + 0x680600, 0x1000);
    write(fb + 0x3000, 0x07E0); nv.display.render();
    assert.deepEqual([...nv.display.pixels.data.subarray(0, 4)], [0, 255, 0, 255], "RGB565");
    write(mmio + 0x680600, 0); write(fb + 0x3000, 0x03E0); nv.display.render();
    assert.deepEqual([...nv.display.pixels.data.subarray(0, 4)], [0, 255, 0, 255], "RGB555");
    crtc(0x13, 1); crtc(0x28, 1); io.port_write8(0x3C8, 7);
    for(const value of [63, 0, 63]) io.port_write8(0x3C9, value);
    cpu.write8(fb + 0x3000, 7); nv.display.render();
    assert.deepEqual([...nv.display.pixels.data.subarray(0, 4)], [255, 0, 255, 255], "indexed palette");
    cpu.write8(mmio + 0x6013D4, 0x28);
    assert.equal(cpu.read8(mmio + 0x6013D5), 1, "CRTC MMIO aliases the port state");
    cpu.write8(mmio + 0x6033D4, 0x28); cpu.write8(mmio + 0x6033D5, 3);
    assert.equal(crtc_read(0x28), 1, "head 2 retains independent state");
    const drive = (scl, sda) => crtc(0x3F, 0x80 | scl << 5 | sda << 4);
    const start = () => { drive(0, 1); drive(1, 1); drive(1, 0); };
    const stop = () => { drive(0, 0); drive(1, 0); drive(1, 1); };
    const send = byte => {
        for(let bit = 7; bit >= 0; bit--) { drive(0, byte >>> bit & 1); drive(1, byte >>> bit & 1); }
        drive(0, 1); drive(1, 1); const ack = !(crtc_read(0x3E) & 8); drive(0, 1); return ack;
    };
    const receive = ack => {
        let byte = 0;
        for(let i = 0; i < 8; i++) { drive(0, 1); drive(1, 1); byte = byte << 1 | crtc_read(0x3E) >> 3 & 1; }
        drive(0, 1); drive(1, ack ? 0 : 1); drive(0, ack ? 0 : 1); return byte;
    };
    start(); assert.equal(send(0xA0), true); assert.equal(send(0), true);
    start(); assert.equal(send(0xA1), true);
    const edid = Uint8Array.from({ length: 128 }, (_, i) => receive(i !== 127)); stop();
    assert.deepEqual(edid, nv.display.ddc.edid, "complete EDID over GPIO I2C, repeated START and final NACK");
    assert.equal(edid.reduce((a, b) => a + b, 0) & 255, 0);
    start(); assert.equal(send(0xA2), false, "unknown I2C address NACK"); stop();
    crtc(0x28, 0); nv.display.render();
    console.log("PASS: NV CRTC lock/mirrors, 8/15/16/32bpp scanout, vblank flips and GPIO EDID");

    const saved = await vm.save_state();
    write(ramin + 0x120, 0);
    write(mmio + 0x100240, 0);
    await vm.restore_state(saved);
    assert.equal(read(ramin + 0x120), 0x12345678);
    assert.equal(read(mmio + 0x100240), 0xBADC0FFE);
    assert.equal(cpu.devices.graphics_adapter.get_state()[2], "geforce_6800");
    assert.throws(() => nv.set_state([1, 256 << 20]), /vram_size mismatch/);
    console.log("PASS: PMC/W1C status and NV40 snapshot round trip");
}
finally { await vm.destroy(); }
