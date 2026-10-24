// A machine with a virtio-gpu at level gfxstream and a guest's driver that a
// test plays by hand (tests/devices/virtio_gpu_gfxstream_vk.js, and
// virtio_gpu_gfxstream_render.js on a real renderer): the control queue,
// the context, ASG rings, and commands as gfxstream's guest encodes them
// (tests/devices/gfxstream_guest_protocol.js).

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { GUEST_COMMANDS, GfxReader, GfxWriter } = await import("./gfxstream_guest_protocol.js");

export { GUEST_COMMANDS, GfxReader, GfxWriter };

export const OK = 0x1100, OK_MAP_INFO = 0x1106;
export const HOST3D = 2, MAPPABLE = 1;
const RING_SIZE = 12288, BUFFER_SIZE = 1 << 20;
/** the context the driver's commands are of */
export const CTX = 1;

/**
 * @param {!Object} renderer the device's renderer
 * @return {!Promise<!Object>} the driver
 */
export async function gfxstream_machine(renderer)
{
    const floppy = new Uint8Array(1474560);
    floppy.set([0xfa, 0xf4, 0xeb, 0xfd]);
    floppy[510] = 0x55;
    floppy[511] = 0xAA;

    const emulator = new V86({
        graphics_adapter: "virtio_gpu",
        graphics_adapter_test: { level: "gfxstream", renderer },
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
    const BDF = 0x12 << 3;
    const pci_read = reg => { io.port_write32(0xcf8, 0x80000000 | BDF << 8 | reg); return io.port_read32(0xcfc) >>> 0; };
    const pci_read8 = reg => pci_read(reg & ~3) >>> 8 * (reg & 3) & 0xFF;
    const hostmem = (pci_read(0x20) & ~0xF) >>> 0;
    let common = 0, notify = 0;
    const bar2 = (pci_read(0x18) & ~0xF) >>> 0;
    for(let at = pci_read8(0x34); at; at = pci_read8(at + 1))
    {
        if(pci_read8(at) !== 0x09) continue;
        const type = pci_read8(at + 3);
        if(type === 1) common = bar2 + pci_read(at + 8);
        if(type === 2) notify = bar2 + pci_read(at + 8);
    }
    const write32 = (address, value) => { for(let i = 0; i < 4; i++) cpu.write8(address + i, value >>> 8 * i & 0xFF); };
    const read32 = address => (cpu.read8(address) | cpu.read8(address + 1) << 8 | cpu.read8(address + 2) << 16 | cpu.read8(address + 3) << 24) >>> 0;
    const write_bytes = (address, bytes) => bytes.forEach((b, i) => cpu.write8(address + i, b));
    const read_bytes = (address, length) => Uint8Array.from({ length }, (_, i) => cpu.read8(address + i));
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

    const REQUEST = 0x200000, REPLY = 0x280000, SLOT = 0x1000;
    let next_slot = 0;
    const used_idx = () => read32(QUEUES[0].used) >>> 16;
    function send(bytes, wait = true)
    {
        const q = QUEUES[0];
        const slot = next_slot++ % 16;
        const head = slot * 2;
        write_bytes(REQUEST + slot * SLOT, bytes);
        write32(q.desc + head * 16, REQUEST + slot * SLOT); write32(q.desc + head * 16 + 4, 0);
        write32(q.desc + head * 16 + 8, bytes.length);
        cpu.write8(q.desc + head * 16 + 12, 1); cpu.write8(q.desc + head * 16 + 14, head + 1);
        write32(q.desc + (head + 1) * 16, REPLY + slot * SLOT); write32(q.desc + (head + 1) * 16 + 4, 0);
        write32(q.desc + (head + 1) * 16 + 8, 256);
        cpu.write8(q.desc + (head + 1) * 16 + 12, 2);
        write32(q.avail + 4 + (q.avail_idx % q.size) * 2, head);
        q.avail_idx = q.avail_idx + 1 & 0xFFFF;
        cpu.write8(q.avail + 2, q.avail_idx & 0xFF);
        cpu.write8(q.avail + 3, q.avail_idx >> 8);
        const before = used_idx();
        cpu.write8(notify, 0);
        cpu.write8(notify + 1, 0);
        if(wait) assert.equal(used_idx(), before + 1 & 0xFFFF, "answered at once");
        return slot;
    }
    const answer = slot => read32(REPLY + slot * SLOT);
    const control = (type, values, wait, fence = null) => {
        const out = new Uint32Array(6 + values.length);
        out[0] = type;
        if(fence)
        {
            out[1] = 1 | (fence.ring !== undefined ? 2 : 0);
            out[2] = fence.id;
            out[5] = fence.ring || 0;
        }
        out[4] = CTX;
        out.set(values, 6);
        return send(new Uint8Array(out.buffer), wait);
    };
    const command = (type, ...values) => answer(control(type, values));
    const submit_3d = (words, wait, fence) => control(0x0207, [words.length * 4, 0, ...words], wait, fence);
    /** until the device has answered every request sent (the GPU's work), a while at most */
    const settle = async (what, before) => {
        for(let i = 0; i < 1000 && used_idx() !== QUEUES[0].avail_idx; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(used_idx(), QUEUES[0].avail_idx, what + ": answered");
    };

    /** a ring of the context: its blob, CONTEXT_CREATE, mapped; the stream and the replies on it */
    function make_ring(res, at)
    {
        assert.equal(command(0x010C, res, HOST3D, MAPPABLE, 0, 0, 0, RING_SIZE + BUFFER_SIZE, 0), OK);
        assert.equal(answer(submit_3d([0x1001, res])), OK, "CONTEXT_CREATE");
        assert.equal(command(0x0208, res, 0, at, 0), OK_MAP_INFO);
        return { res, base: hostmem + at, buffer: hostmem + at + RING_SIZE, write_offset: 0, write_pos: 0, reply_pos: 0, flags: false };
    }
    function push(ring, bytes)
    {
        if(!ring.flags) { bytes = Uint8Array.of(0, 0, 0, 0, ...bytes); ring.flags = true; }
        write_bytes(ring.buffer + ring.write_offset, bytes);
        write32(ring.base + 128 + (ring.write_pos & 2047), ring.write_offset);
        write32(ring.base + 128 + (ring.write_pos & 2047) + 4, bytes.length);
        ring.write_pos = ring.write_pos + 8 >>> 0;
        write32(ring.base + 8, ring.write_pos);
        ring.write_offset = (ring.write_offset + Math.ceil(bytes.length / 4096) * 4096) % BUFFER_SIZE;
    }
    const ping = ring => assert.equal(answer(submit_3d([0x1002, ring.res])), OK, "PING");
    /** what the device wrote back since the last read */
    function replies(ring)
    {
        const pos = read32(ring.base + 8192 + 8);
        const bytes = read_bytes(ring.buffer + (ring.reply_pos & BUFFER_SIZE - 1), pos - ring.reply_pos >>> 0);
        ring.reply_pos = pos;
        return bytes;
    }
    const driver = {
        emulator, cpu, gpu, hostmem, write32, read32, write_bytes, read_bytes, send, answer, control, command, submit_3d, used_idx, settle,
        make_ring, push, ping, replies,
        /** the last sequence number */
        seqno: 0,
        /** the ring `call` uses unless told */
        ring: null,
        /** a command as the guest encodes it: opcode, size, sequence number, parameters */
        encode(name, a, number = ++driver.seqno)
        {
            const [opcode, write] = GUEST_COMMANDS[name];
            const w = new GfxWriter(64);
            w.u32(opcode); w.u32(0); w.u32(number);
            write(w, a);
            const out = w.result().slice();
            new DataView(out.buffer).setUint32(4, out.length, true);
            return out;
        },
        /** a command buffer's command: opcode, size, parameters (no handle) */
        encode_cb(name, a)
        {
            const [opcode, write] = GUEST_COMMANDS[name];
            const w = new GfxWriter(64);
            w.u32(opcode); w.u32(0);
            write(w, a);
            const out = w.result().slice();
            new DataView(out.buffer).setUint32(4, out.length, true);
            return out;
        },
        /** a command and its reply (decoded as the guest decodes it, into a) */
        call(name, a, ring = driver.ring)
        {
            push(ring, driver.encode(name, a));
            ping(ring);
            const read = GUEST_COMMANDS[name][2];
            if(!read) return a;
            const bytes = replies(ring);
            const r = new GfxReader(bytes);
            read(r, a);
            assert.equal(r.p, bytes.length, name + ": the reply read whole");
            return a;
        },
    };
    return driver;
}
