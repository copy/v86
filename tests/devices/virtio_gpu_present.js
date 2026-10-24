#!/usr/bin/env node

// virtio-gpu's scanouts shown without readbacks (docs/gfxstream-plan.md G4):
// a renderer that says it can (its "caps" to the device's "hello": the page's
// compositor) gets GX's SURFACE_PRESENT for a 3D scanout's flushes, the
// rectangle flushed, and no readback; a cursor over the picture, a second
// scanout or a renderer that cannot bring the readbacks back (and the
// renderer's picture goes, SURFACE_PRESENT of sid 0); so does SET_SCANOUT 0.
// GX is a fake here: it logs the batches' commands and answers readbacks
// with zeros. The renderer's side (the copy into the compositor's layer) is
// tests/glbridge/virtio_gpu_present_browser_test.html.

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { GX } = await import("../../src/graphics_adapters/renderer_protocol.js");
const QUERY_REGION_BYTES = 16 * 1024, READBACK_HEADER_BYTES = 16, RESPONSE_OK = 1;

let to_device = null, present = true;
const log = [];
const renderer = {
    "post": message => {
        if(message["type"] === "hello" || message["type"] === "reset")
        {
            // (as svga_renderer.js does: after the device's listener is up)
            queueMicrotask(() => to_device({ "type": "caps", "present": present }));
            return;
        }
        if(message["type"] !== "submit") return;
        const words = new Uint32Array(message["bytes"].buffer, message["bytes"].byteOffset, message["bytes"].byteLength >> 2);
        for(let at = 4; at < words[2];)
        {
            const op = words[at], body = words[at + 1], p = words.subarray(at + 2, at + 2 + body);
            if(op === GX.SURFACE_PRESENT) log.push(["present", ...p]);
            if(op === GX.SURFACE_READBACK)
            {
                const [sid, , , , , , w, h, , id] = p;
                log.push(["readback", sid]);
                const answer = new Uint8Array(READBACK_HEADER_BYTES + w * h * 4);
                const v = new DataView(answer.buffer);
                v.setUint32(0, id, true);
                v.setUint32(4, w * h * 4, true);
                v.setUint32(12, RESPONSE_OK, true);
                to_device({ "type": "write", "offset": QUERY_REGION_BYTES, "bytes": answer });
            }
            at += 2 + body;
        }
        to_device({ "type": "done", "seq": message["seq"] });
    },
    "listen": handler => { to_device = handler; },
};

// hlt forever
const floppy = new Uint8Array(1474560);
floppy.set([0xfa, 0xf4, 0xeb, 0xfd]);
floppy[510] = 0x55;
floppy[511] = 0xAA;

const emulator = new V86({
    graphics_adapter: "virtio_gpu",
    graphics_adapter_test: { level: "virgl43", renderer, scanouts: 2 },
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    fda: { buffer: floppy.buffer },
    boot_order: 0x321,
    autostart: true,
    memory_size: 64 << 20,
    vram_size: 16 << 20,
    net_device: { type: "none" },
    disable_speaker: true,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));
await emulator.wait_until_vga_screen_contains("Booting from Floppy", { timeout_msec: 30000 });
await emulator.stop();

const cpu = emulator.v86.cpu, io = cpu.io;
const gpu = cpu.devices.graphics_adapter.device["virtio_gpu"];
assert.equal(gpu.virgl.direct_present, true, "the renderer's caps: it shows pictures");
const BDF = 0x12 << 3;
const pci_read = reg => { io.port_write32(0xcf8, 0x80000000 | BDF << 8 | reg); return io.port_read32(0xcfc) >>> 0; };
const pci_read8 = reg => pci_read(reg & ~3) >>> 8 * (reg & 3) & 0xFF;
let common = 0, notify = 0;
const bar2 = (pci_read(0x18) & ~0xF) >>> 0;
for(let at = pci_read8(0x34); at; at = pci_read8(at + 1))
{
    if(pci_read8(at) !== 0x09) continue;
    const type = pci_read8(at + 3);
    if(type === 1) common = bar2 + pci_read(at + 8);
    if(type === 2) notify = bar2 + pci_read(at + 8);
}

// The transport
const write32 = (address, value) => { for(let i = 0; i < 4; i++) cpu.write8(address + i, value >>> 8 * i & 0xFF); };
const read32 = address => (cpu.read8(address) | cpu.read8(address + 1) << 8 | cpu.read8(address + 2) << 16 | cpu.read8(address + 3) << 24) >>> 0;
const write_bytes = (address, bytes) => bytes.forEach((b, i) => cpu.write8(address + i, b));
const w8 = (offset, value) => cpu.write8(common + offset, value);
const w16 = (offset, value) => { cpu.write8(common + offset, value & 0xFF); cpu.write8(common + offset + 1, value >> 8); };
const QUEUES = [{ size: 0, desc: 0x100000, avail: 0x101000, used: 0x102000, avail_idx: 0 },
    { size: 0, desc: 0x110000, avail: 0x111000, used: 0x112000, avail_idx: 0 }];
w8(20, 0);
w8(20, 3);
write32(common, 0);
const features0 = read32(common + 4);
write32(common + 8, 0); write32(common + 12, features0);
write32(common + 8, 1); write32(common + 12, 1);
w8(20, 11);
QUEUES.forEach((q, i) => {
    w16(22, i);
    q.size = cpu.read8(common + 24) | cpu.read8(common + 25) << 8;
    write32(common + 32, q.desc); write32(common + 36, 0);
    write32(common + 40, q.avail); write32(common + 44, 0);
    write32(common + 48, q.used); write32(common + 52, 0);
    for(let j = 0; j < 0x3000; j += 4) write32(q.desc + j, 0);
    w16(28, 1);
});
w8(20, 15);

const REQUEST = 0x200000, REPLY = 0x280000;
function submit(bytes)
{
    const q = QUEUES[0];
    write_bytes(REQUEST, bytes);
    write32(q.desc, REQUEST); write32(q.desc + 4, 0); write32(q.desc + 8, bytes.length);
    cpu.write8(q.desc + 12, 1); cpu.write8(q.desc + 14, 1);
    write32(q.desc + 16, REPLY); write32(q.desc + 20, 0); write32(q.desc + 24, 64);
    cpu.write8(q.desc + 28, 2);
    write32(q.avail + 4 + (q.avail_idx % q.size) * 2, 0);
    q.avail_idx = q.avail_idx + 1 & 0xFFFF;
    cpu.write8(q.avail + 2, q.avail_idx & 0xFF);
    cpu.write8(q.avail + 3, q.avail_idx >> 8);
    cpu.write8(notify, 0);
    cpu.write8(notify + 1, 0);
    return read32(REPLY);
}
const command = (type, ...values) => {
    const out = new Uint32Array(6 + values.length);
    out[0] = type;
    out.set(values, 6);
    return submit(new Uint8Array(out.buffer));
};
const OK = 0x1100;
const RESOURCE_CREATE_3D = 0x0204, SET_SCANOUT = 0x0103, RESOURCE_FLUSH = 0x0104;
// (PIPE_TEXTURE_2D, VIRGL_FORMAT_B8G8R8A8_UNORM, PIPE_BIND_RENDER_TARGET | SCANOUT)
const create = (id, width, height) => command(RESOURCE_CREATE_3D, id, 2, 1, 0x2 | 0x40000, width, height, 1, 1, 0, 0, 0, 0);
const W = 64, H = 48;

assert.equal(create(1, W, H), OK, "RESOURCE_CREATE_3D");
log.length = 0;
assert.equal(command(SET_SCANOUT, 0, 0, W, H, 0, 1), OK, "SET_SCANOUT of the 3D resource");
assert.deepEqual(log, [["present", 1, 0, 0, W, H, 0, 0, W, H]], "shown by the renderer, all of it, no readback");
log.length = 0;
assert.equal(command(RESOURCE_FLUSH, 8, 4, 16, 8, 1, 0), OK);
assert.deepEqual(log, [["present", 1, 8, 4, 16, 8, 8, 4, W, H]], "a flush: its rectangle");
assert.equal(gpu.scanouts[0].direct, 1);
console.log("PASS: a 3D scanout's flushes shown by the renderer, without readbacks");

// a cursor over the picture: the device's picture again (read back), the renderer's goes
log.length = 0;
gpu.cursor.visible = true;
gpu.cursor_shown();
assert.deepEqual(log[0], ["present", 0, 0, 0, 0, 0, 0, 0, 0, 0], "the renderer's picture goes");
assert.ok(log.slice(1).length && log.slice(1).every(e => e[0] === "readback" && e[1] === 1), "the scanout read back: " + JSON.stringify(log));
assert.equal(gpu.scanouts[0].direct, 0);
log.length = 0;
assert.equal(command(RESOURCE_FLUSH, 0, 0, W, H, 1, 0), OK);
assert.ok(log.length && log.every(e => e[0] === "readback"), "with the cursor shown: readbacks");
gpu.cursor.visible = false;
log.length = 0;
assert.equal(command(RESOURCE_FLUSH, 0, 0, 8, 8, 1, 0), OK);
assert.deepEqual(log, [["present", 1, 0, 0, 8, 8, 0, 0, W, H]], "the cursor hidden: shown by the renderer again");
console.log("PASS: a cursor over it: read back");

// a second scanout: the device composes the two
assert.equal(create(2, W, H), OK);
log.length = 0;
assert.equal(command(SET_SCANOUT, 0, 0, W, H, 1, 2), OK, "SET_SCANOUT of the second display");
assert.ok(log.every(e => e[0] === "readback"), "the second scanout read back: " + JSON.stringify(log));
log.length = 0;
assert.equal(command(RESOURCE_FLUSH, 0, 0, W, H, 1, 0), OK);
assert.deepEqual(log[0], ["present", 0, 0, 0, 0, 0, 0, 0, 0, 0], "two scanouts: the renderer's picture goes");
assert.ok(log.slice(1).every(e => e[0] === "readback"));
assert.equal(command(SET_SCANOUT, 0, 0, 0, 0, 1, 0), OK, "the second display off");
log.length = 0;
assert.equal(command(RESOURCE_FLUSH, 0, 0, W, H, 1, 0), OK);
assert.deepEqual(log, [["present", 1, 0, 0, W, H, 0, 0, W, H]], "one scanout again: shown by the renderer");
console.log("PASS: two scanouts: read back");

// SET_SCANOUT 0: the renderer's picture goes
log.length = 0;
assert.equal(command(SET_SCANOUT, 0, 0, 0, 0, 0, 0), OK);
assert.deepEqual(log, [["present", 0, 0, 0, 0, 0, 0, 0, 0, 0]], "the scanout off");
console.log("PASS: SET_SCANOUT 0");

// a renderer that cannot (no compositor: node's, a headless one): readbacks as before
present = false;
gpu.virgl.reset();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(gpu.virgl.direct_present, false);
assert.equal(create(3, W, H), OK);
log.length = 0;
assert.equal(command(SET_SCANOUT, 0, 0, W, H, 0, 3), OK);
assert.ok(log.length && log.every(e => e[0] === "readback"), "read back: " + JSON.stringify(log));
console.log("PASS: a renderer without a compositor: readbacks");

emulator.destroy();
