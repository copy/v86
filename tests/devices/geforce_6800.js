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
