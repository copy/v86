#!/usr/bin/env node
// The ARM core's physical address space through the emulator
// (docs/arm64-virt-android16-plan.md P1.5, P1.7; src/rust/aarch64/bus.rs,
// src/virt/io.js): new V86 with cpu_type "arm64" loads the ARM core and the
// arm64 CPU; RAM at 0x4000_0000, device ranges above 4 GiB (one at
// 0x50_1000_0000, a device at 0x60_0000_0000) and two 0x200 windows
// inside one 128 KiB block, holes, 16- and 64-bit accesses (a FIFO's 16-bit
// read pops once), the map's generation, an access across regions that
// writes nothing, code keys and the writes that retire watched code; the
// PCIe host (P5.6, P5.10): a virtio-rng function's 64-bit BAR sized, placed
// above and below 4 GiB and moved through the high ECAM, decoded only with
// its memory space enabled.
//
//   node tests/a64/address_space.mjs   (A64_WASM: the core, default build/v86-arm64.wasm)
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const emulator = new V86({
    cpu_type: "arm64", graphics_adapter: "none", memory_size: 64 << 20, autostart: false, log_level: 0,
    virtio_transport: "pci", virtio_rng: true,
    wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm",
});
await new Promise((resolve, reject) => {
    emulator.add_listener("emulator-loaded", resolve);
    emulator.add_listener("emulator-error", reject);
});
const cpu = emulator.v86.cpu;
// (the test takes the first three virtio-mmio slots, empty until P5.1: two devices and a hole)
for(const owner of cpu.virtio_mmio_slots.slice(0, 3)) cpu.io.unregister_mmio(owner);
const e = cpu.wm.exports;
try
{
    assert.equal(cpu.cpu_type, "arm64");
    assert.equal(e.isa_aarch64(), 1);
    const split = pa => [Number(BigInt(pa) & 0xFFFFFFFFn), Number(BigInt(pa) >> 32n)];
    const kind = pa => e.a64_bus_lookup(...split(pa));
    const detail = pa => e.a64_bus_lookup_detail(...split(pa));
    const read = (pa, width) => { const v = e.a64_bus_read(...split(pa), width); return [e.a64_bus_status(), v]; };
    const write = (pa, width, value) => e.a64_bus_write(...split(pa), width, BigInt(value));

    // RAM from 0x4000_0000, holes around it
    assert.equal(kind(0x40000000), 1);
    assert.equal(detail(0x40000000 + 0x1234), 0x1234);
    assert.equal(kind(0x3FFFFFFF), 0);
    assert.equal(kind(0x40000000 + (64 << 20)), 0);
    assert.equal(cpu.memory_size[0], 64 << 20);
    console.log("PASS RAM at 0x4000_0000, 64 MiB");

    // device ranges: a FIFO of 16-bit words, a 64-bit register, two windows of 0x200
    const fifo = [0x1111, 0x2222, 0x3333];
    const accesses = [];
    const generation = e.a64_bus_generation();
    const fifo_owner = cpu.io.register_mmio(0x0a000000, 0x200, {
        read: (offset, width) => { accesses.push(["fifo", offset, width]); return offset === 0 && width === 2 ? fifo.shift() : 0xFFFF; },
        write: () => {},
    });
    const window_owner = cpu.io.register_mmio(0x0a000200, 0x200, {
        read: (offset, width) => { accesses.push(["window", offset, width]); return offset; },
        write: (offset, width, value) => accesses.push(["window-write", offset, width, value]),
    });
    let register = 0n;
    const ecam = cpu.io.register_mmio([0x10000000, 0x50], 0x10000000, {
        read: (offset, width) => offset + width,
        write: () => {},
    });
    const high = cpu.io.register_mmio([0, 0x60], 0x1000, {
        read: (offset, width) => { accesses.push(["high", offset, width]); return register; },
        write: (offset, width, value) => { accesses.push(["high-write", offset, width]); register = value; },
    });
    assert.notEqual(e.a64_bus_generation(), generation, "mapping changes the generation");
    assert.equal(kind(0x0a000000), 3);
    assert.equal(detail(0x0a000000), fifo_owner);
    assert.equal(detail(0x0a0001ff), fifo_owner);
    assert.equal(detail(0x0a000200), window_owner);
    assert.equal(kind(0x0a000400), 0, "the next 0x200 is a hole");
    assert.equal(detail(0x5010000000n + 0x123n), ecam);
    assert.equal(detail(0x6000000000n), high);
    assert.throws(() => cpu.io.register_mmio(0x0a000100, 0x200, { read: () => 0, write: () => {} }), /overlaps/);
    assert.throws(() => cpu.io.register_mmio(0x40000000, 0x1000, { read: () => 0, write: () => {} }), /overlaps RAM/);
    assert.throws(() => cpu.io.register_mmio([0, 0x100], 0x1000, { read: () => 0, write: () => {} }), /40-bit/);
    console.log("PASS device ranges: narrow windows in one 128 KiB block, above 4 GiB, overlaps refused");

    // widths: one 16-bit read pops one FIFO entry, 64-bit values round-trip
    accesses.length = 0;
    assert.deepEqual(read(0x0a000000, 2), [0, 0x1111n]);
    assert.deepEqual(accesses, [["fifo", 0, 2]]);
    assert.deepEqual(fifo, [0x2222, 0x3333]);
    assert.deepEqual(read(0x0a000204, 4), [0, 4n]);
    assert.equal(write(0x6000000008n, 8, 0x1122334455667788n), 0);
    assert.deepEqual(read(0x6000000008n, 8), [0, 0x1122334455667788n]);
    assert.deepEqual(read(0x5010000010n, 4), [0, 0x14n]);
    console.log("PASS 16- and 64-bit device accesses (a 16-bit FIFO read pops once)");

    // holes, the PA range, accesses across regions write nothing
    assert.equal(read(0x0b000000, 4)[0], 1, "a hole: external abort");
    assert.equal(read(1n << 40n, 1)[0], 2, "beyond 40 bits: address size fault");
    const end = 0x40000000 + (64 << 20);
    assert.equal(write(end - 8, 8, 0), 0);
    assert.equal(write(end - 4, 8, -1n), 1);
    assert.deepEqual(read(end - 8, 8), [0, 0n], "nothing written before the end of RAM");
    assert.equal(read(0x0a0001fe, 4)[0], 1, "across two devices");
    console.log("PASS holes, the 40-bit range and accesses across regions (nothing written)");

    // code keys and the writes that retire code compiled from a page
    assert.equal(e.a64_bus_code_key(0x40003000, 0), 3);
    assert.equal(e.a64_bus_code_key(0x0a000000, 0), -1);
    assert.ok(e.a64_test_watch_page(5));
    const retired = e.a64_test_retired();
    assert.equal(write(0x40004ff8, 8, 1), 0, "the page before");
    assert.equal(e.a64_test_retired(), retired);
    assert.equal(write(0x40005010, 4, 1), 0);
    assert.equal(e.a64_test_retired(), retired + 1, "a CPU store to the watched page");
    assert.ok(e.a64_test_watch_page(5));
    cpu.write_blob_physical(new Uint8Array([1, 2, 3]), 0x40005800);
    assert.equal(e.a64_test_retired(), retired + 2, "a write from JavaScript (loader, DMA)");
    console.log("PASS code keys and write notification");

    // the PCIe host (P5.6, P5.10): configuration through the high ECAM;
    // virtio-rng at 00:01.0 with BAR 4 (64-bit, prefetchable, 16 KiB)
    const config = (devfn, register) => 0x4010000000n + BigInt(devfn << 12 | register);
    const cfg_read = (devfn, register, width = 4) => { const [status, value] = read(config(devfn, register), width); assert.equal(status, 0); return Number(value); };
    const cfg_write = (devfn, register, value, width = 4) => assert.equal(write(config(devfn, register), width, BigInt(value >>> 0)), 0);
    const RNG = 1 << 3;
    assert.equal(cfg_read(0, 0), 0x00081B36, "00:00.0: the QEMU PCIe host bridge");
    assert.equal(cfg_read(0, 8) >>> 8, 0x060000, "a host bridge");
    assert.equal(cfg_read(RNG, 0), 0x10441AF4, "00:01.0: virtio-rng, non-transitional");
    assert.equal(cfg_read(RNG, 0x2C), 0x11001AF4, "QEMU's subsystem");
    assert.equal(cfg_read(RNG, 8) >>> 8, 0x00FF00, "class: other");
    assert.equal(cfg_read(2 << 3, 0), 0xFFFFFFFF, "00:02.0: nothing");
    assert.equal(cfg_read(RNG, 0x3D, 1), 1, "INTA");
    assert.equal(cfg_read(RNG, 0x20), 0xC, "BAR 4: 64-bit, prefetchable, unassigned");
    assert.equal(cfg_read(RNG, 4, 2), 0, "no decode at power-on");
    cfg_write(RNG, 0x20, -1);
    cfg_write(RNG, 0x24, -1);
    assert.deepEqual([cfg_read(RNG, 0x20), cfg_read(RNG, 0x24)], [0xFFFFC00C, 0xFFFFFFFF], "sizing: 16 KiB, both halves");
    const map_generation = e.a64_bus_generation();
    cfg_write(RNG, 0x20, 0x4000);
    cfg_write(RNG, 0x24, 0x80);
    assert.deepEqual([cfg_read(RNG, 0x20), cfg_read(RNG, 0x24)], [0x400C, 0x80]);
    // (the common configuration: num_queues at 0x12, the features' second word: VERSION_1)
    assert.deepEqual(read(0x8000004012n, 2), [0, 0xFFFFn], "memory space disabled: nothing decodes");
    cfg_write(RNG, 4, 2, 2);
    assert.deepEqual(read(0x8000004012n, 2), [0, 1n], "above 4 GiB: one queue");
    assert.equal(write(0x8000004000n, 4, 1n), 0);
    assert.deepEqual(read(0x8000004004n, 4), [0, 1n], "VERSION_1");
    cfg_write(RNG, 0x20, 0x10004000);
    assert.deepEqual(read(0x8010004012n, 2), [0, 1n], "half moved: at 0x80_1000_4000");
    cfg_write(RNG, 0x24, 0);
    assert.deepEqual(read(0x8010004012n, 2), [0, 0xFFFFn], "the old place reads all ones");
    assert.deepEqual(read(0x10004012, 2), [0, 1n], "below 4 GiB, in the 32-bit window");
    assert.deepEqual(read(0x10004000, 8), [0, 1n | 1n << 32n], "an 8-byte access is two 4-byte ones");
    assert.equal(e.a64_bus_generation(), map_generation, "the windows stay where they are: the map does not change");
    cfg_write(RNG, 4, 0, 2);
    assert.deepEqual(read(0x10004012, 2), [0, 0xFFFFn], "memory space disabled again");
    cfg_write(RNG, 4, 2, 2);
    cpu.devices.pci.reset();
    assert.deepEqual([cfg_read(RNG, 0x20), cfg_read(RNG, 0x24), cfg_read(RNG, 4, 2)], [0xC, 0, 0], "a reset: power-on configuration");
    assert.deepEqual(read(0x10004012, 2), [0, 0xFFFFn], "and nothing decoded");
    console.log("PASS the PCIe host: high ECAM, a 64-bit BAR sized, above and below 4 GiB, decode with memory space enabled, reset");

    // unmapping
    cpu.io.unregister_mmio(window_owner);
    assert.equal(kind(0x0a000200), 0);
    console.log("PASS unmapping");

    // snapshot identity
    const state = cpu.get_state(true);
    assert.deepEqual(state[103], ["virt", 2, "v86-aarch64-v1"]);
    assert.throws(() => cpu.validate_state(Object.assign([], state, { 103: ["i440fx", 1] })), /machine_type: "i440fx"/);
    assert.throws(() => cpu.validate_state(Object.assign([], state, { 103: undefined })), /machine_type: "i440fx"/);
    console.log("PASS snapshot identity");
}
finally
{
    await emulator.destroy();
}
