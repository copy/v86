"use strict";
// The v86gl device (glbridge/v86gl_device.js) on v86's virtio_devices, driven
// through its ports: PCI identity, negotiation, a real virtqueue, request
// validation, the renderer channel (batches, readbacks, availability), reset,
// state, index wrap and BAR relocation.
const assert = require("node:assert/strict");
const path = require("node:path");
const { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js");

function localChannel() {
    const handlers = [null, null];
    const end = (self, other) => ({ remote: false, post: message => handlers[other] && handlers[other](message),
        listen: handler => { handlers[self] = handler; } });
    return { device: end(0, 1), host: end(1, 0) };
}

(async () => {
    global.DEBUG = false;
    const { V86 } = await import("../../src/browser/starter.js");
    const channel = localChannel();
    const descriptor = createV86GLDevice(channel.device);
    let lastEvent;
    let expectedCommandBytes = 4;
    let batches = 0;
    let releases = 0;
    let disappearDuringSubmit = false;
    channel.host.listen(message => {
        // the arena's owner let it go: its sessions end (review S1-10)
        if (message.type === "released") { ++releases; return; }
        assert.equal(message.type, "batch");
        batches++;
        lastEvent = message;
        if (disappearDuringSubmit) channel.host.post({ type: "available", value: false });
        assert.equal(message.frameId, 42);
        assert.equal(message.bytes.byteLength, expectedCommandBytes);
        channel.host.post({ type: "done", id: message.id });
    });
    const write = (event, offset, bytes) =>
        channel.host.post({ type: "write", generation: event.generation, offset, bytes });
    const arenaBytes = () => descriptor.get_state()[2];

    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: path.join(__dirname, "../../build/v86.wasm"),
        memory_size: 32 * 1024 * 1024,
        bios: { buffer: new Uint8Array(65536).fill(0xf4).buffer },
        disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        net_device: { type: "none" }, autostart: false,
        virtio_devices: [descriptor],
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    try {
        const cpu = emulator.v86.cpu, io = cpu.io;
        const pci = cpu.devices.virtio_devices[0].virtio;
        assert.equal(pci.pci_id, 0x13 << 3, "the slot the installed driver knows");
        assert.equal(pci.pci_space[0] | pci.pci_space[1] << 8, 0x1af4);
        assert.equal(pci.pci_space[2] | pci.pci_space[3] << 8, 0x107f);
        assert.ok(!pci.pci_bars.some(bar => bar && bar.fixed), "BARs can relocate");
        const ram = cpu.read_blob(0, 32 * 1024 * 1024);
        const mem = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
        let common = 0xf100, notify = 0xf200;
        const arena = 0x100000;
        const table = 0x10000, avail = table + 128, used = table + 160;
        const req = table + 256, reply = table + 288;
        const w8 = (o, v) => io.port_write8(common + o, v);
        const w16 = (o, v) => io.port_write16(common + o, v);
        const w32 = (o, v) => io.port_write32(common + o, v);
        let idx = 0;
        function setup() {
            w8(20, 0); w8(20, 3);
            w32(0, 1); assert.equal(io.port_read32(common + 4), 1);
            w32(8, 0); w32(12, 1); w32(8, 1); w32(12, 1);
            w8(20, 11); assert.equal(io.port_read8(common + 20), 11);
            w16(22, 0); w16(24, 8);
            w32(32, table); w32(36, 0); w32(40, avail); w32(44, 0);
            w32(48, used); w32(52, 0);
            for (let i = 0; i < 320; i++) mem.setUint8(table + i, 0);
            mem.setUint32(table, req, true); mem.setUint32(table + 8, 24, true);
            mem.setUint16(table + 12, 1, true); mem.setUint16(table + 14, 1, true);
            mem.setUint32(table + 16, reply, true); mem.setUint32(table + 24, 16, true);
            mem.setUint16(table + 28, 2, true);
            mem.setUint16(avail, 1, true);
            w16(28, 1); w8(20, 15); idx = 0;
        }
        function request(op, address = 0, length = 0, flags = 0, high = 0) {
            [op, address, high, length, flags, 0].forEach((v, i) => mem.setUint32(req + i * 4, v, true));
            mem.setUint32(reply, 0xffffffff, true);
            mem.setUint16(avail + 4 + (idx & 7) * 2, 0, true);
            idx = (idx + 1) & 0xffff;
            mem.setUint16(avail + 2, idx, true);
            io.port_write16(notify, 0);
            assert.equal(mem.getUint16(used + 2, true), idx, "used ring acknowledges request");
            assert.equal(mem.getUint32(used + 4 + ((idx - 1) & 7) * 8 + 4, true), 16);
            return mem.getUint32(reply, true);
        }
        assert.equal(io.port_read32(0xf400) >>> 0, 0x324c4756, "configuration space: magic");
        assert.equal(io.port_read32(0xf408), 16 * 1024 * 1024, "configuration space: arena bytes");
        setup();
        assert.equal(request(2, 0, 32), 2, "submit without registered arena fails");
        assert.equal(request(1, arena, 16 * 1024 * 1024, 0, 1), 1, "64-bit address without RAM rejected");
        assert.equal(request(1, 0x2000000, 16 * 1024 * 1024), 1, "out-of-RAM arena rejected");
        assert.equal(request(1, arena, 16 * 1024 * 1024), 0);
        assert.equal(request(1, arena, 16 * 1024 * 1024), 1, "registration cannot replace live arena");
        [0x324c4756, 1, 0, 42, 1, 4, 0, 0].forEach((v, i) => mem.setUint32(arena + i * 4, v, true));
        mem.setUint16(arena + 32, 0xfff1, true); mem.setUint16(arena + 34, 0, true);
        assert.equal(request(2, 0, 36), 3, "missing host renderer is visible to guest");
        assert.equal(batches, 0);
        channel.host.post({ type: "available", value: true });
        assert.equal(request(2, 0, 36, 1), 0);
        assert.equal(lastEvent.flags, 1);
        assert.equal(lastEvent.batchAddr, arena + 32);
        assert.equal(lastEvent.bytes.buffer, ram.buffer, "on one thread the batch is a view of guest RAM");
        disappearDuringSubmit = true;
        const acceptedBefore = batches;
        assert.equal(request(2, 0, 36), 0, "accepted work stays successful if the host disappears inside post");
        assert.equal(batches, acceptedBefore + 1);
        assert.equal(request(2, 0, 36), 3, "subsequent work is refused before execution");
        assert.equal(batches, acceptedBefore + 1);
        disappearDuringSubmit = false;channel.host.post({ type: "available", value: true });
        assert.equal(request(2, 0, 36), 0, "same owner can continue after availability returns");
        write(lastEvent, 0x100, new Uint8Array([7]));
        assert.equal(mem.getUint8(arena + 0x100), 7);
        assert.throws(() => write(lastEvent, 16 * 1024 * 1024, new Uint8Array([1])), /outside/);
        const beforeUnregister = lastEvent;
        const releasesBefore = releases;
        assert.equal(request(3), 0);
        assert.equal(releases, releasesBefore + 1, "unregistering tells the renderer the owner is gone");
        assert.equal(request(3), 0);
        assert.equal(releases, releasesBefore + 1, "once: no arena, no owner");
        write(beforeUnregister, 0x100, new Uint8Array([9]));
        assert.equal(mem.getUint8(arena + 0x100), 7, "unregistration revokes readbacks of earlier batches");
        assert.equal(request(1, arena, 16 * 1024 * 1024), 0);
        assert.equal(request(2, 0, 36), 0);
        const beforeReset = lastEvent;
        // [name, transport, device state, host state], as in a snapshot
        const device = cpu.devices.virtio_devices[0];
        const saved = device.get_state();
        saved[1] = pci.get_state().map(x => x && typeof x.get_state === "function" ? x.get_state() : x);
        w8(20, 0);
        assert.equal(arenaBytes(), 0, "guest virtio reset revokes the arena");
        write(beforeReset, 0x100, new Uint8Array([9]));
        assert.equal(mem.getUint8(arena + 0x100), 7);
        device.set_state(saved);
        assert.equal(arenaBytes(), 16 * 1024 * 1024);
        assert.equal(io.port_read8(common + 20), 15, "transport restored with the device");
        assert.throws(() => descriptor.set_state([1, 0, 32, 1, 0, 0, 0, 0]), /Unsupported/);
        // state[92] from before virtio_devices: [magic, transport, arena, bytes, frame, last, submits, 0, checkpoint]
        const checkpoint = new Uint8Array([1, 2]);
        assert.deepEqual(descriptor.upgrade_state([0x56514731, ["transport"], arena, 16 * 1024 * 1024, 5, 6, 7, 0, checkpoint]),
            [["transport"], [2, arena, 16 * 1024 * 1024, 5, 6, 7], checkpoint]);
        assert.equal(descriptor.upgrade_state(["virtio_devices", 1]), null);
        // Real split-ring 16-bit wrap, rather than just modulo queue size.
        idx = 65535;
        pci.queues[0].avail_last_idx = idx;
        mem.setUint16(used + 2, idx, true); mem.setUint16(avail + 2, idx, true);
        assert.equal(request(2, 0, 36), 0);
        assert.equal(idx, 0);
        setup();
        mem.setUint32(req, 1, true); mem.setUint16(avail + 2, 1, true);
        mem.setUint16(table + 14, 0, true); // descriptor cycle
        io.port_write16(notify, 0);
        assert.ok(io.port_read8(common + 20) & 64, "malformed queue requests a device reset");
        setup();
        w8(20, 3);
        mem.setUint16(avail + 2, 1, true);
        io.port_write16(notify, 0);
        assert.equal(mem.getUint16(used + 2, true), 0, "no consumption before DRIVER_OK");
        setup();
        // Relocate every BAR via real PCI config writes, as an OS enumerator can.
        for (let bar = 0; bar < 4; bar++) {
            io.port_write32(0xcf8, (0x80000000 | (0x13 << 11) | (0x10 + bar * 4)) >>> 0);
            io.port_write32(0xcfc, 0xe001 + bar * 0x100);
        }
        common = 0xe000; notify = 0xe100;
        assert.equal(io.port_read8(common + 20), 15);
        assert.equal(io.port_read32(0xe300) >>> 0, 0x324c4756);
        assert.equal(request(1, arena, 16 * 1024 * 1024), 0);
        assert.equal(request(2, 0, 36), 0, "submissions work after PCI BAR relocation");
        // The shipping D3D9, D3D8 and DirectDraw DLLs put D9WG_MAGIC in
        // VGL2 reserved0. Only OpenGL zeroes it; it is not a virtio field.
        const envelope = new Uint8Array(40);
        const d9 = new DataView(envelope.buffer);
        d9.setUint16(0, 0xffe1, true); d9.setUint16(2, 0xffff, true);
        d9.setUint32(4, 32, true); d9.setUint32(8, 0x47573944, true);
        d9.setUint16(12, 1, true); d9.setUint16(14, 3, true);
        d9.setUint32(16, 42, true); d9.setUint32(32, 1, true); d9.setUint32(36, 1, true);
        expectedCommandBytes = envelope.length;
        mem.setUint32(arena + 20, envelope.length, true);
        mem.setUint32(arena + 24, 0x47573944, true);
        ram.set(envelope, arena + 32);
        assert.equal(request(2, 0, 32 + envelope.length), 0, "shipping D9WG descriptor accepted by virtqueue");
        assert.deepEqual([...lastEvent.bytes], [...envelope]);
        // Two outstanding requests are drained with one used-index/IRQ flush.
        setup();
        [1, arena, 0, 16 * 1024 * 1024, 0, 0].forEach((v, i) => mem.setUint32(req + i * 4, v, true));
        const req2 = table + 320, reply2 = table + 352;
        [3, 0, 0, 0, 0, 0].forEach((v, i) => mem.setUint32(req2 + i * 4, v, true));
        mem.setUint32(table + 32, req2, true); mem.setUint32(table + 40, 24, true);
        mem.setUint16(table + 44, 1, true); mem.setUint16(table + 46, 3, true);
        mem.setUint32(table + 48, reply2, true); mem.setUint32(table + 56, 16, true);
        mem.setUint16(table + 60, 2, true);
        mem.setUint16(avail, 0, true);
        mem.setUint16(avail + 4, 0, true); mem.setUint16(avail + 6, 2, true); mem.setUint16(avail + 2, 2, true);
        let interrupts = 0, invalidations = 0;
        const raise = pci.raise_irq;
        pci.raise_irq = function(type) { interrupts++; return raise.call(this, type); };
        const dirty = cpu.jit_dirty_cache;
        cpu.jit_dirty_cache = (start, end) => {
            if ((start === reply || start === reply2) && end === start + 16) invalidations++;
            return dirty(start, end);
        };
        io.port_write16(notify, 0);
        cpu.jit_dirty_cache = dirty; pci.raise_irq = raise;
        assert.equal(mem.getUint16(used + 2, true), 2);
        assert.equal(mem.getUint32(reply, true), 0); assert.equal(mem.getUint32(reply2, true), 0);
        assert.equal(interrupts, 1, "one completion interrupt for multiple pending requests");
        assert.equal(invalidations, 2, "direct replies invalidate guest JIT code as before");
        assert.equal(arenaBytes(), 0);
        setup();
        [1, arena, 0, 16 * 1024 * 1024, 0, 0].forEach((v, i) => mem.setUint32(req + i * 4, v, true));
        mem.setUint16(avail + 4, 0, true); mem.setUint16(avail + 6, 8, true); mem.setUint16(avail + 2, 2, true);
        io.port_write16(notify, 0);
        assert.equal(mem.getUint16(used + 2, true), 1, "publish accepted reply before rejecting later malformed head");
        assert.ok(io.port_read8(common + 20) & 64);
        setup();
        mem.setUint32(table + 16, 0xa0000, true); mem.setUint16(avail + 2, 1, true);
        io.port_write16(notify, 0);
        assert.ok(io.port_read8(common + 20) & 64, "direct replies must target RAM, not VGA MMIO");
        setup();
        assert.equal(request(1, arena, 16 * 1024 * 1024), 0, "register again after a reset");
        // The renderer going away is visible to the guest again
        channel.host.post({ type: "available", value: false });
        assert.equal(request(2, 0, 32 + envelope.length), 3);
        console.log("virtio_v86gl_test: PCI capabilities, negotiation, real virtqueue, validation, renderer channel, reset, state, wrap and BAR relocation passed");
    } finally { await emulator.destroy(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
