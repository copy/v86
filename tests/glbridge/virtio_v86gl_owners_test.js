"use strict";
// The real virtqueue and physical RAM, with legacy GL plus two D3D owners.
const assert = require("node:assert/strict");
const path = require("node:path");
const { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js");

(async () => {
    global.DEBUG = false;
    const { V86 } = await import("../../src/browser/starter.js");
    const MiB = 1024 * 1024, size = 16 * MiB;
    const arenas = [MiB, 17 * MiB, 33 * MiB], outgoing = [];
    let host;
    const descriptor = createV86GLDevice({ remote: true, post: message => {
        outgoing.push(message);
        if (message.type === "batch") host({ type: "done", id: message.id });
    }, listen: handler => { host = handler; } });
    const emulator = new V86({ graphics_adapter: "bochs_vga",
        wasm_path: path.join(__dirname, "../../build/v86.wasm"), memory_size: 64 * MiB,
        bios: { buffer: new Uint8Array(65536).fill(0xf4).buffer },
        disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        net_device: { type: "none" }, autostart: false, virtio_devices: [descriptor] });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    try {
        const cpu = emulator.v86.cpu, io = cpu.io;
        const ram = cpu.read_blob(0, 64 * MiB), mem = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
        const common = 0xf100, table = 0x10000, avail = table + 128, used = table + 160;
        const req = table + 256, reply = table + 288;
        const w8 = (o, v) => io.port_write8(common + o, v);
        const w16 = (o, v) => io.port_write16(common + o, v);
        const w32 = (o, v) => io.port_write32(common + o, v);
        let idx;
        function setup(owners = true) {
            w8(20, 0);w8(20, 3);
            w32(0, 0);assert.equal(io.port_read32(common + 4) & 3, 3);
            w32(8, 0);w32(12, owners ? 3 : 1);w32(8, 1);w32(12, 1);
            w8(20, 11);assert.equal(io.port_read8(common + 20), 11);
            w16(22, 0);w16(24, 8);
            w32(32, table);w32(36, 0);w32(40, avail);w32(44, 0);w32(48, used);w32(52, 0);
            ram.fill(0, table, table + 320);
            mem.setUint32(table, req, true);mem.setUint32(table + 8, 24, true);
            mem.setUint16(table + 12, 1, true);mem.setUint16(table + 14, 1, true);
            mem.setUint32(table + 16, reply, true);mem.setUint32(table + 24, 16, true);
            mem.setUint16(table + 28, 2, true);mem.setUint16(avail, 1, true);
            w16(28, 1);w8(20, 15);idx = 0;
        }
        function request(op, owner, address = 0, length = 0, flags = 0) {
            [op, address, 0, length, flags, owner].forEach((v, i) => mem.setUint32(req + i * 4, v, true));
            mem.setUint32(reply, 0xffffffff, true);
            mem.setUint16(avail + 4 + (idx & 7) * 2, 0, true);idx = (idx + 1) & 0xffff;
            mem.setUint16(avail + 2, idx, true);io.port_write16(0xf200, 0);
            assert.equal(mem.getUint16(used + 2, true), idx);
            return mem.getUint32(reply, true);
        }
        function batch(address, d3d = true) {
            const bytes = d3d ? 12 : 4;
            [0x324c4756, 1, 0, 42, 1, bytes, 0, 0].forEach((v, i) => mem.setUint32(address + i * 4, v, true));
            mem.setUint16(address + 32, d3d ? 0xffe1 : 0xfff1, true);
            mem.setUint16(address + 34, d3d ? 0xffff : 4, true);
            if (d3d) { mem.setUint32(address + 36, 4, true);mem.setUint32(address + 40, 0x47573944, true); }
            return bytes + 32;
        }
        const latest = owner => outgoing.filter(m => m.type === "batch" && (m.ownerToken || 0) === owner).at(-1);
        const write = (event, value) => host({ type: "write", generation: event.generation, offset: 4096, bytes: new Uint8Array([value]) });
        const releases = () => outgoing.filter(m => m.type === "released").map(m => m.ownerToken);
        host({ type: "available", value: true });
        setup(false);
        assert.equal(request(1, 11, arenas[1], size), 1, "owner word requires negotiated feature");
        setup();
        for (let i = 0; i < arenas.length; i++) assert.equal(request(1, [0, 11, 22][i], arenas[i], size), 0);
        assert.equal(request(1, 33, arenas[1], size), 1, "another owner cannot alias A's physical memory");
        assert.equal(request(1, 33, arenas[1] + MiB, size), 1, "partial overlap is rejected");
        assert.equal(request(1, 11, arenas[2], size), 1, "A cannot redirect its arena to B");
        for (let i = 0; i < arenas.length; i++) {
            const owner = [0, 11, 22][i];assert.equal(request(2, owner, 0, batch(arenas[i], owner !== 0)), 0);
        }
        const gl = latest(0), a = latest(11), b = latest(22);
        assert.equal(new Set([gl.generation, a.generation, b.generation]).size, 3);
        // The browser consumes asynchronously after the driver reuses DMA RAM.
        const frozen = Buffer.from(a.bytes);
        ram.fill(0, arenas[1] + 32, arenas[1] + 44);
        assert.deepEqual(Buffer.from(a.bytes), frozen, "remote commands own a copy of guest memory");
        write(gl, 10);write(a, 11);write(b, 22);
        assert.deepEqual(arenas.map(at => mem.getUint8(at + 4096)), [10, 11, 22]);
        host({ type: "write", generation: gl.generation, inlineId: gl.id, offset: 4097, bytes: new Uint8Array([37]) });
        assert.equal(mem.getUint8(arenas[0] + 4097), 37, "D3D submissions do not expire another arena's GL inline lease");
        assert.equal(request(1, 11, arenas[1], size), 0);
        write(a, 12);assert.equal(mem.getUint8(arenas[1] + 4096), 12, "idempotent register retains A's write lease");
        assert.equal(request(2, 11, 0, batch(arenas[1], false)), 1, "D3D owners cannot submit raw GL");
        assert.equal(request(3, 11), 0);assert.equal(request(3, 11), 0);
        write(a, 99);write(b, 23);write(gl, 13);
        assert.deepEqual(arenas.map(at => mem.getUint8(at + 4096)), [13, 12, 23]);
        assert.deepEqual(releases(), [11]);

        // A new physical lease may reuse the token; old callbacks stay revoked.
        assert.equal(request(1, 11, arenas[1], size), 0);
        assert.equal(request(2, 11, 0, batch(arenas[1])), 0);
        const a2 = latest(11);assert.notEqual(a2.generation, a.generation);
        const saved = descriptor.get_state();
        descriptor.set_state(saved);
        write(a2, 99);write(b, 99);write(gl, 99);
        assert.deepEqual(arenas.map(at => mem.getUint8(at + 4096)), [13, 12, 23], "restore revokes all old callbacks");
        assert.equal(request(2, 11, 0, batch(arenas[1])), 0);
        assert.equal(request(2, 22, 0, batch(arenas[2])), 0);
        assert.equal(latest(11).ownerToken, 11);assert.equal(latest(22).ownerToken, 22);
        write(latest(11), 31);write(latest(22), 32);
        const bad = JSON.parse(JSON.stringify(saved));bad[7][0][1] = arenas[0];
        assert.throws(() => descriptor.set_state(bad), /Invalid/);
        write(latest(22), 33);assert.equal(mem.getUint8(arenas[2] + 4096), 33, "bad restore retains current leases");
        const beforeReset = latest(22), releaseCount = releases().length;
        setup();
        write(beforeReset, 99);assert.equal(mem.getUint8(arenas[2] + 4096), 33);
        assert.equal(releases().length, releaseCount, "queue timeout reset preserves logical sessions");
        assert.equal(request(2, 22, 0, 44), 2);
        assert.equal(request(3, 22), 0, "owner exits before registering again after timeout");
        assert.deepEqual(releases().slice(-1), [22]);
        const resetSaved = descriptor.get_state();descriptor.set_state(resetSaved);
        assert.equal(request(3, 11), 0, "unmapped logical lease survives a checkpoint");
        assert.equal(request(3, 0), 0);assert.equal(request(3, 0), 0);
        assert.deepEqual(releases(), [11, 22, 11, 0]);
        for (const version of [2, 3]) {
            descriptor.set_state([version, arenas[0], size, 1, 0, 1, ""]);
            assert.equal(request(2, 0, 0, batch(arenas[0], false)), 0);
            assert.equal(request(3, 0), 0);
        }
        console.log("virtio_v86gl_owners_test: negotiated multi-owner arenas, physical isolation, write leases, scoped release, queue reset and v2/v3/v4 checkpoints passed");
    } finally { emulator.destroy(); }
})().catch(error => { console.error(error);process.exitCode = 1; });
