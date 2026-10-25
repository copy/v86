#!/usr/bin/env node
// The ranchu machine's devices (docs/aarch32-plan.md R6.1, R6.2) on
// cpu_type "arm32", driven through their registers as the Android
// emulator image's Linux 3.10 drives them:
// - the device tree (src/virt/ranchu.js, decompiled by dtc): the GICv2, the
//   simple-framebuffer at the top of RAM kept out of the memory node, the
//   goldfish devices with both compatible strings, the virtio-mmio slots
//   from the last one down; the kernel command line;
// - virtio-mmio's legacy transport (version 1): VIRTIO_F_VERSION_1 hidden, a
//   queue placed by GuestPageSize and QueuePFN, a virtio-blk read through
//   it, a reset clearing the page frame numbers;
// - goldfish_events: its pages (the name, the event bits, the axes), keys
//   from the keyboard's scancodes, a touch, the interrupt while events wait;
// - goldfish_battery, goldfish_audio (a buffer empty after its samples' time);
// - goldfish_pipe: qemud's boot-properties over a channel (the frames, the
//   wake on read), an unknown service refused, a snapshot closing channels;
// - the framebuffer: RGB565 written to the simple-framebuffer reaches the
//   screen at the next third vblank, and only when it changed;
// - /cache's empty filesystem (src/android/ext4.js): the superblock, the
//   group, the root directory and lost+found;
// - a snapshot of the machine restores (machine type, GICv2 state) and is
//   refused by the virt machine.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PictureSink } from "../lib/picture_sink.mjs";
import { make_empty_ext4, ext4_writes } from "../../src/android/ext4.js";
import { ranchu_cmdline, ranchu_dtb, ranchu_framebuffer, RANCHU_DISPLAY } from "../../src/virt/ranchu.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const RAM = 0x40000000, MEMORY = 64 << 20;

// ---- the device tree and the command line

{
    const framebuffer = ranchu_framebuffer(MEMORY, RANCHU_DISPLAY);
    assert.deepEqual(framebuffer, { base: RAM + MEMORY - 0x200000, size: 0x200000, width: 480, height: 800 });
    const directory = fs.mkdtempSync(os.tmpdir() + "/ranchu-dtb-");
    fs.writeFileSync(directory + "/ranchu.dtb", ranchu_dtb({ cores: 2, memory_size: MEMORY, bootargs: "x", arm32: true, framebuffer }));
    const dts = execFileSync("dtc", ["-q", "-I", "dtb", "-O", "dts", directory + "/ranchu.dtb"], { encoding: "utf8" });
    const has = (pattern, what) => assert.match(dts, pattern, what);
    has(/model = "ranchu"/, "the board's name");
    has(/memory@40000000 \{[^}]*reg = <0x00 0x40000000 0x00 0x3e00000>/, "RAM without the framebuffer");
    has(/framebuffer@43e00000 \{[^}]*format = "r5g6b5";[^}]*stride = <0x3c0>;[^}]*height = <0x320>;[^}]*width = <0x1e0>;[^}]*compatible = "simple-framebuffer"/,
        "the simple-framebuffer");
    assert.doesNotMatch(dts, /goldfish_fb@/, "no goldfish framebuffer with the simple-framebuffer");
    for(const [name, kind] of [["goldfish_pipe@a010000", "android-pipe"], ["goldfish_events@9040000", "goldfish-events-keypad"],
        ["goldfish_audio@9030000", "goldfish-audio"], ["goldfish_battery@9020000", "goldfish-battery"]])
    {
        has(new RegExp(name + " \\{[^}]*compatible = \"google," + kind + "\", \"generic," + kind + "\""), name);
    }
    has(/intc@8000000 \{[^}]*reg = <0x00 0x8000000 0x00 0x10000 0x00 0x8010000 0x00 0x10000>;[^}]*compatible = "arm,cortex-a15-gic"/, "a GICv2");
    has(/interrupts = <0x01 0x0d 0x304 0x01 0x0e 0x304 0x01 0x0b 0x304 0x01 0x0a 0x304>/, "the timer's PPIs for both cores");
    const slots = [...dts.matchAll(/virtio_mmio@([0-9a-f]+)/g)].map(m => parseInt(m[1], 16));
    assert.equal(slots.length, 32);
    assert.ok(slots.every((base, i) => i === 0 || base < slots[i - 1]), "the slots from the last one down");
    has(/psci \{[^}]*cpu_on = <0x84000003>/, "32-bit PSCI calls");
    has(/cpu@1 \{[^}]*enable-method = "psci";[^}]*compatible = "arm,cortex-a15"/, "the cores");
    // (arm64's: the virt machine's GICv3, the goldfish framebuffer)
    fs.writeFileSync(directory + "/ranchu64.dtb", ranchu_dtb({ cores: 1, memory_size: MEMORY, arm32: false }));
    const dts64 = execFileSync("dtc", ["-q", "-I", "dtb", "-O", "dts", directory + "/ranchu64.dtb"], { encoding: "utf8" });
    assert.match(dts64, /compatible = "arm,gic-v3"/);
    assert.match(dts64, /goldfish_fb@9010000 \{[^}]*compatible = "google,goldfish-fb", "generic,goldfish-fb"/);
    assert.match(dts64, /memory@40000000 \{[^}]*reg = <0x00 0x40000000 0x00 0x4000000>/);
    fs.rmSync(directory, { recursive: true });

    const cmdline = ranchu_cmdline({ arm32: true, bootanim: false });
    assert.equal(cmdline, "qemu=1 androidboot.hardware=ranchu console=ttyAMA0 android.checkjni=1 qemu.gles=0 qemu.encrypt=0 qemu.wifi=0 " +
        "loop.max_part=7 android.bootanim=0");
    console.log("PASS: the device tree and the command line");
}

// ---- the machine

const DISK = 1 << 20;
const disk = new Uint8Array(DISK).map((_, i) => i * 7 + (i >> 9) & 0xFF);
const sink = new PictureSink();
const emulator = new V86({
    cpu_type: "arm32", machine_type: "ranchu", memory_size: MEMORY, autostart: false, log_level: 0,
    wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm",
    virtio_disks: [{ buffer: disk.slice().buffer }], net_device: { type: "none" },
    graphics_adapter: "none", screen_adapter: sink,
    ranchu_properties: { "ro.test.answer": "42" },
});
await new Promise((resolve, reject) => {
    emulator.add_listener("emulator-loaded", resolve);
    emulator.add_listener("emulator-error", reject);
});
const cpu = emulator.v86.cpu;
assert.equal(cpu.machine_type, "ranchu");
assert.equal(cpu.gic_v2, true, "arm32's ranchu has a GICv2");
assert.equal(cpu.devices.pci, undefined, "no PCIe host");
/** the interrupt lines' levels the devices set */
const levels = new Map();
const set_irq = cpu.set_irq.bind(cpu);
cpu.set_irq = (intid, level) => { levels.set(intid, level); set_irq(intid, level); };
const SPI = n => 32 + n;
const u16 = (address, value) => cpu.write_blob_physical(new Uint8Array([value & 0xFF, value >> 8]), address);
const u32 = (address, value) => cpu.write_blob_physical(new Uint8Array(new Uint32Array([value]).buffer), address);
const bytes_at = (address, length) => cpu.read_blob_physical(address, length);

// ---- virtio-mmio's legacy transport, with virtio-blk

{
    const transport = cpu.virtio_mmio[31];
    const reg = (offset, value) => value === undefined ? transport.read(offset, 4) >>> 0 : transport.write(offset, 4, value);
    assert.equal(reg(0x000), 0x74726976);
    assert.equal(reg(0x004), 1, "version 1: the legacy transport");
    assert.equal(reg(0x008), 2, "virtio-blk in the last slot");
    const empty = cpu.io.ranges.find(range => range && range.base === 0x0A000000 + 30 * 0x200);
    assert.equal(empty.handler.read(0x004, 4), 1, "an empty slot is legacy too");
    reg(0x070, 0);
    reg(0x070, 1 | 2);
    reg(0x014, 1);
    assert.equal(reg(0x010) & 1, 0, "VIRTIO_F_VERSION_1 is not offered");
    reg(0x014, 0);
    reg(0x024, 0); reg(0x020, 0);
    reg(0x028, 4096);
    const QUEUE = 8, PFN = (RAM + 0x10000) / 4096;
    const DESC = PFN * 4096, AVAIL = DESC + 16 * QUEUE, USED = Math.ceil((AVAIL + 6 + 2 * QUEUE) / 4096) * 4096;
    cpu.write_blob_physical(new Uint8Array(0x3000), DESC);
    reg(0x030, 0);
    assert.ok(reg(0x034) >= QUEUE);
    reg(0x038, QUEUE);
    reg(0x03C, 4096);
    reg(0x040, PFN);
    assert.equal(reg(0x040), PFN, "QueuePFN reads back");
    reg(0x070, 1 | 2 | 4);
    // (a read of sectors 3 and 4: the header, the data, the status)
    const header = RAM + 0x20000, data = RAM + 0x21000, status = RAM + 0x22000;
    cpu.write_blob_physical(new Uint8Array(16), header);
    u32(header, 0); u32(header + 8, 3);
    cpu.write_blob_physical(new Uint8Array([0xFF]), status);
    const descriptor = (n, address, length, flags, next) => {
        u32(DESC + 16 * n, address); u32(DESC + 16 * n + 4, 0); u32(DESC + 16 * n + 8, length);
        u16(DESC + 16 * n + 12, flags); u16(DESC + 16 * n + 14, next);
    };
    descriptor(0, header, 16, 1, 1);
    descriptor(1, data, 1024, 1 | 2, 2);
    descriptor(2, status, 1, 2, 0);
    u16(AVAIL + 4, 0);
    u16(AVAIL + 2, 1);
    reg(0x050, 0);
    for(let i = 0; i < 100 && cpu.read16_physical(USED + 2) !== 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cpu.read16_physical(USED + 2), 1, "the used ring, aligned after the available ring");
    assert.equal(bytes_at(status, 1)[0], 0, "VIRTIO_BLK_S_OK");
    assert.deepEqual(bytes_at(data, 1024), disk.subarray(3 * 512, 5 * 512), "sectors 3 and 4");
    assert.equal(reg(0x060) & 1, 1, "the used buffer's interrupt");
    assert.equal(levels.get(SPI(16 + 31)), true);
    reg(0x064, 1);
    assert.equal(levels.get(SPI(16 + 31)), false);
    reg(0x070, 0);
    assert.equal(reg(0x040), 0, "a reset forgets the queue's page");
    console.log("PASS: virtio-mmio's legacy transport (virtio-blk)");
}

// ---- goldfish_events

{
    const events = cpu.devices.goldfish_events;
    const page = (n) => {
        events.write(0x00, n);
        const length = events.read(0x04, 4);
        return Uint8Array.from({ length }, (_, i) => events.read(0x08 + i, 1));
    };
    assert.equal(new TextDecoder().decode(page(0)), "qwerty2");
    const bit = (bytes, n) => (bytes[n >> 3] >> (n & 7) & 1) === 1;
    const types = page(0x10000);
    assert.ok(bit(types, 0) && bit(types, 1) && bit(types, 3), "EV_SYN, EV_KEY, EV_ABS");
    const keys = page(0x10001);
    assert.ok(bit(keys, 30) && bit(keys, 102) && bit(keys, 158) && bit(keys, 0x14A), "KEY_A, HOME, BACK, BTN_TOUCH");
    const abs = page(0x10003);
    assert.ok(bit(abs, 0) && bit(abs, 1) && bit(abs, 0x35) && bit(abs, 0x36) && bit(abs, 0x39), "the axes");
    const ranges = new Uint32Array(page(0x20003).slice().buffer);
    assert.deepEqual([...ranges.subarray(0, 4)], [0, 0x7FFF, 0, 0], "ABS_X's range");
    const take = () => {
        const out = [];
        while(levels.get(SPI(5))) out.push([events.read(0, 4), events.read(0, 4), events.read(0, 4) | 0]);
        return out;
    };
    assert.deepEqual(take(), [], "nothing waits");
    emulator.bus.send("keyboard-code", 0x1E);
    emulator.bus.send("keyboard-code", 0x9E);
    emulator.bus.send("keyboard-code", 0xE0);
    emulator.bus.send("keyboard-code", 0x48);
    assert.deepEqual(take(), [[1, 30, 1], [0, 0, 0], [1, 30, 0], [0, 0, 0], [1, 103, 1], [0, 0, 0]], "A down and up, Up (extended) down");
    events.tap(240, 400, 480, 800);
    const x = Math.round(240 / 480 * 0x7FFF), y = Math.round(400 / 800 * 0x7FFF);
    assert.deepEqual(take(), [
        [3, 0x2F, 0], [3, 0x39, 1], [3, 0x35, x], [3, 0x36, y], [1, 0x14A, 1], [3, 0, x], [3, 1, y], [0, 0, 0],
        [3, 0x2F, 0], [3, 0x39, -1], [1, 0x14A, 0], [0, 0, 0],
    ], "a touch down and up");
    console.log("PASS: goldfish_events");
}

// ---- goldfish_battery and goldfish_audio

{
    const battery = cpu.devices.goldfish_battery;
    assert.deepEqual([0x08, 0x0C, 0x10, 0x14, 0x18].map(r => battery.read(r)), [1, 1, 1, 1, 100], "AC online, charging, good, present, full");
    const audio = cpu.devices.goldfish_audio;
    assert.equal(audio.read(0x18), 0, "no input");
    audio.write(0x04, 3);
    const now = cpu.clock.now();
    audio.write(0x10, 44100 * 4 / 10);
    assert.equal(audio.timer(now + 50) > 0, true, "the buffer plays");
    assert.equal(levels.get(SPI(4)) || false, false);
    audio.timer(now + 101);
    assert.equal(levels.get(SPI(4)), true, "BUFFER_1_EMPTY after 100 ms of samples");
    assert.equal(audio.read(0x00), 1);
    assert.equal(levels.get(SPI(4)), false);
    console.log("PASS: goldfish_battery, goldfish_audio");
}

// ---- goldfish_pipe: qemud's boot properties

{
    const pipe = cpu.devices.goldfish_pipe;
    assert.equal(pipe.read(0x24), 1, "version 1");
    const BUFFER = RAM + 0x30000;
    const command = (channel, cmd, bytes, size) => {
        pipe.write(0x08, channel);
        if(bytes) cpu.write_blob_physical(bytes, BUFFER);
        pipe.write(0x0C, size ?? (bytes ? bytes.length : 0));
        pipe.write(0x10, BUFFER);
        pipe.write(0x00, cmd);
        return pipe.read(0x04) | 0;
    };
    const text = s => new TextEncoder().encode(s);
    assert.equal(command(7, 1), 0, "OPEN");
    assert.equal(command(7, 4, text("pipe:qemud:boot-properties\0")), 27, "the service's name");
    assert.equal(command(7, 6, null, 64), -2, "nothing to read yet: AGAIN");
    assert.equal(command(7, 7), 0, "WAKE_ON_READ");
    assert.equal(levels.get(SPI(7)) || false, false);
    assert.equal(command(7, 4, text("0004list")), 8);
    assert.equal(levels.get(SPI(7)), true, "the reader woken");
    assert.equal(pipe.read(0x08), 7, "the channel with wakes");
    assert.equal(pipe.read(0x14), 2, "PIPE_WAKE_READ");
    assert.equal(levels.get(SPI(7)), false);
    assert.equal(command(7, 3), 1 | 2, "POLL: readable and writable");
    const count = command(7, 6, null, 4096);
    const answer = new TextDecoder().decode(bytes_at(BUFFER, count));
    const frames = [];
    for(let at = 0; at < answer.length;)
    {
        const length = parseInt(answer.slice(at, at + 4), 16);
        frames.push(answer.slice(at + 4, at + 4 + length));
        at += 4 + length;
    }
    assert.deepEqual(frames, ["qemu.sf.lcd_density=240", "qemu.hw.mainkeys=0", "ro.test.answer=42", "\0"], "the properties, then the end");
    assert.equal(command(8, 1), 0);
    assert.equal(command(8, 4, text("pipe:opengles\0")), -1, "an unknown service is refused");
    assert.equal(command(8, 2), 0, "CLOSE");
    assert.equal(command(8, 3), -1, "a closed channel is gone");
    // (a snapshot: the channels come back closed)
    pipe.set_state(pipe.get_state());
    assert.equal(levels.get(SPI(7)), true);
    assert.equal(pipe.read(0x08), 7);
    assert.equal(pipe.read(0x14), 1, "PIPE_WAKE_CLOSED");
    assert.equal(pipe.read(0x08), 0, "no more wakes");
    console.log("PASS: goldfish_pipe");
}

// ---- the framebuffer (the simple-framebuffer's scanout)

{
    const fb = cpu.devices.goldfish_fb;
    const frame = cpu.ranchu_framebuffer;
    assert.equal(frame.base, RAM + MEMORY - 0x200000);
    assert.equal(fb.read(0x00), 480);
    assert.equal(fb.read(0x04), 800);
    assert.equal(fb.read(0x1C), Math.round(480 * 25.4 / 240), "the width in millimetres");
    const pixels = new Uint16Array(480 * 800);
    pixels.fill(0xF800);
    pixels[481] = 0x07E0;
    pixels[480 * 800 - 1] = 0x001F;
    cpu.write_blob_physical(new Uint8Array(pixels.buffer), frame.base);
    let renders = 0;
    const render = fb.render.bind(fb);
    fb.render = source => { renders++; render(source); };
    for(let i = 0; i < 3; i++) fb.on_vblank();
    assert.equal(renders, 1, "drawn at the third vblank");
    const rgb = n => [...sink.rgba.subarray(4 * n, 4 * n + 3)];
    assert.deepEqual(rgb(0), [255, 0, 0]);
    assert.deepEqual(rgb(481), [0, 255, 0]);
    assert.deepEqual(rgb(480 * 800 - 1), [0, 0, 255]);
    for(let i = 0; i < 3; i++) fb.on_vblank();
    assert.equal(renders, 1, "not again while it is the same");
    u16(frame.base, 0xFFFF);
    for(let i = 0; i < 3; i++) fb.on_vblank();
    assert.equal(renders, 2, "again when it changed");
    assert.deepEqual(rgb(0), [255, 255, 255]);
    console.log("PASS: the framebuffer");
}

// ---- /cache's filesystem

{
    const image = make_empty_ext4(64 << 20, "cache", 1595289711);
    const view = new DataView(image.buffer);
    const sb = 1024;
    assert.equal(view.getUint16(sb + 56, true), 0xEF53, "the magic");
    assert.equal(view.getUint32(sb + 4, true), 16384, "the blocks");
    assert.equal(view.getUint32(sb + 24, true), 2, "4 KiB blocks");
    assert.equal(new TextDecoder().decode(image.subarray(sb + 120, sb + 125)), "cache");
    const table = view.getUint32(4096 + 8, true);
    const inode = n => table * 4096 + (n - 1) * 256;
    assert.equal(view.getUint16(inode(2), true), 0x41ED, "the root: a directory");
    const entries = block => {
        const out = [];
        for(let at = block * 4096; at < (block + 1) * 4096;)
        {
            const length = view.getUint16(at + 4, true);
            out.push([view.getUint32(at, true), new TextDecoder().decode(image.subarray(at + 8, at + 8 + image[at + 6]))]);
            at += length;
        }
        return out;
    };
    assert.deepEqual(entries(view.getUint32(inode(2) + 40, true)), [[2, "."], [2, ".."], [11, "lost+found"]]);
    assert.deepEqual(entries(view.getUint32(inode(11) + 40, true)), [[11, "."], [2, ".."]]);
    // (the free counts: the superblock's are the group's)
    assert.equal(view.getUint32(sb + 12, true), view.getUint16(4096 + 12, true));
    assert.equal(view.getUint32(sb + 16, true), view.getUint16(4096 + 14, true));
    // (a larger one, as the metadata's writes: groups of 128 MiB, the superblock's copies in groups 0, 1, 3, 5, 7, 9)
    const writes = ext4_writes(1200 << 20, "userdata", 1);
    const copies = writes.filter(w => w.bytes.length === 1024 && new DataView(w.bytes.buffer).getUint16(56, true) === 0xEF53);
    assert.deepEqual(copies.map(w => [w.offset / 4096 / 32768, new DataView(w.bytes.buffer).getUint16(90, true)]),
        [[1024 / 4096 / 32768, 0], [1, 1], [3, 3], [5, 5], [7, 7], [9, 9]]);
    assert.equal(new DataView(copies[0].bytes.buffer).getUint32(4, true), 1200 << 8, "the blocks");
    assert.throws(() => make_empty_ext4(1000), /a multiple of 4 KiB/);
    console.log("PASS: /cache's filesystem");
}

// ---- snapshots

{
    const state = await emulator.save_state();
    await emulator.restore_state(state);
    assert.equal(cpu.devices.goldfish_fb.read(0x00), 480);
    const virt = new V86({
        cpu_type: "arm32", memory_size: MEMORY, autostart: false, log_level: 0,
        wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm", graphics_adapter: "none", net_device: { type: "none" },
    });
    await new Promise(resolve => virt.add_listener("emulator-loaded", resolve));
    await assert.rejects(virt.restore_state(state), /machine_type: "ranchu"/, "the virt machine refuses ranchu's snapshot");
    await virt.destroy();
    console.log("PASS: snapshots");
}
await emulator.destroy();
