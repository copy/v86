#!/usr/bin/env node

// Device memory behind a movable PCI memory BAR (src/rust/cpu/mmio_ram.rs,
// docs/display-design.md), exercised through the VGA's
// linear frame buffer: it is decoded where SeaBIOS assigns BAR0, pixels
// written there reach the screen, it moves when the guest moves the BAR (and
// stops being decoded at the old place), the banked window does not care
// where it is, and a snapshot brings the BAR back where the guest had it.

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const { V86 } = await import("../../src/main.js");

// hlt forever
const floppy = new Uint8Array(1474560);
floppy.set([0xfa, 0xf4, 0xeb, 0xfd]);
floppy[510] = 0x55;
floppy[511] = 0xAA;

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    fda: { buffer: floppy.buffer },
    boot_order: 0x321,
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    vram_size: 8 * 1024 * 1024,
    net_device: { type: "none" },
    disable_speaker: true,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));
await new Promise(resolve => setTimeout(resolve, 3000));
await emulator.stop();

const cpu = emulator.v86.cpu, io = cpu.io, vga = cpu.devices.vga;
const VGA_BDF = 0x12 << 3;
const pci_read = reg => { io.port_write32(0xcf8, 0x80000000 | VGA_BDF << 8 | reg); return io.port_read32(0xcfc) >>> 0; };
const pci_write = (reg, value) => { io.port_write32(0xcf8, 0x80000000 | VGA_BDF << 8 | reg); io.port_write32(0xcfc, value); };
const dispi = (index, value) => { io.port_write16(0x1ce, index); io.port_write16(0x1cf, value); };
const WIDTH = 64, HEIGHT = 48;
const pixel = (x, y) => {
    cpu.devices.display.request_frame();
    const p = (y * vga.pixels.width + x) * 4;
    return [...vga.pixels.data.subarray(p, p + 3)];
};
const put = (base, x, y, xrgb) => {
    const address = base + (y * WIDTH + x) * 4;
    for(let i = 0; i < 4; i++) cpu.write8(address + i, xrgb >>> 8 * i & 0xFF);
};

const bar = pci_read(0x10);
const base = (bar & ~0xF) >>> 0;
console.log("SeaBIOS put BAR0 at " + base.toString(16) + " (flags " + (bar & 0xF) + ")");
assert.equal(bar & 0xF, 0x8, "BAR0 stays a prefetchable 32-bit memory BAR");
assert.equal(base % (8 << 20), 0, "aligned to its size");
assert.equal(vga.lfb_address, base, "the frame buffer is decoded where the BAR is");

// 64x48, 32 bpp, LFB
dispi(4, 0); dispi(1, WIDTH); dispi(2, HEIGHT); dispi(3, 32); dispi(4, 0x41);
put(base, 10, 5, 0x00112233);
assert.deepEqual(pixel(10, 5), [0x11, 0x22, 0x33], "written through the LFB, shown on the screen");

const moved = (base + (16 << 20)) >>> 0;
pci_write(0x10, 0xFFFFFFFF);
assert.equal(pci_read(0x10), (~((8 << 20) - 1) | 0x8) >>> 0, "sizing reports 8 MiB");
assert.equal(vga.lfb_address, base, "sizing does not move it");
pci_write(0x10, moved);
assert.equal(pci_read(0x10), (moved | 0x8) >>> 0, "the guest moves BAR0");
assert.equal(vga.lfb_address, moved);
assert.equal(cpu.read8(moved + (5 * WIDTH + 10) * 4), 0x33, "the same memory at the new place");
put(moved, 11, 5, 0x00445566);
assert.deepEqual(pixel(11, 5), [0x44, 0x55, 0x66], "written at the new place, shown on the screen");
put(base, 12, 5, 0x00778899);
assert.deepEqual(pixel(12, 5), [0, 0, 0], "the old place no longer reaches the frame buffer");
console.log("PASS: the frame buffer follows BAR0, " + base.toString(16) + " -> " + moved.toString(16));

// The banked window at 0xA0000 reaches the frame buffer wherever the BAR is
dispi(5, 0);
cpu.write8(0xA0000 + (6 * WIDTH + 2) * 4 + 2, 0x7f);
assert.equal(cpu.read8(moved + (6 * WIDTH + 2) * 4 + 2), 0x7f);
assert.deepEqual(pixel(2, 6), [0x7f, 0, 0], "banked writes are shown too");
console.log("PASS: the banked window is independent of BAR0");

// Page flipping: with the second page shown (Y offset), writes to the pages
// above and below it are dirty but not on the screen, and render passes no
// rows for them (it passed a negative height, and the CPU Worker's copy threw
// "Invalid typed array length": Yuri's Revenge drawing its DirectDraw back buffer)
{
    const heights = [];
    const update_buffer = vga.display.update_buffer;
    vga.display.update_buffer = function(layers)
    {
        for(const l of layers) heights.push(l.buffer_height);
        return update_buffer.call(this, layers);
    };
    dispi(9, HEIGHT);
    pixel(0, 0);
    heights.length = 0;
    for(const y of [4, HEIGHT - 10, 2 * HEIGHT + 3])
    {
        put(moved, 3, y, 0x00ABCDEF);
        pixel(0, 0);
    }
    assert.deepEqual(heights, [], "no rows for the pages that are not shown");
    put(moved, 4, HEIGHT + 7, 0x00123456);
    assert.deepEqual(pixel(4, 7), [0x12, 0x34, 0x56], "the shown page still reaches the screen");
    assert.ok(heights.length === 1 && heights[0] > 0, "the rows of the written page: " + heights);
    vga.display.update_buffer = update_buffer;
    dispi(9, 0);
    console.log("PASS: dirty rows off the shown page are not passed on");
}

const state = await emulator.save_state();
pci_write(0x10, base);
assert.equal(vga.lfb_address, base);
await emulator.restore_state(state);
assert.equal(pci_read(0x10), (moved | 0x8) >>> 0, "the snapshot's BAR");
assert.equal(vga.lfb_address, moved, "the frame buffer is back where the snapshot's guest had it");
assert.equal(cpu.read8(moved + (5 * WIDTH + 11) * 4), 0x66);
console.log("PASS: a snapshot restores the moved BAR");

await emulator.destroy();
