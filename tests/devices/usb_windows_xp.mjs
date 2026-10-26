#!/usr/bin/env node
// USB on Windows XP (docs/usb.md): the owner's XP image (i440FX, IDE, no
// ACPI: the standard PC HAL with the PIC) with the UHCI controller and the
// tablet. A tools disk has USBCHECK.EXE (tests/x64/windows_usb.c): it writes
// the controller's, the tablet's and its HID mouse's devices (Device
// Manager's problem code) and then the cursor's position every 300 ms, while
// the page's pointer goes to the corners, the centre and a 5x5 grid of the
// screen. Every device started without a problem (the controller, its root
// hub, the tablet and its mouse), and every position where the page's
// pointer was. A USB disk (U2, a FAT16 image in memory) in the second port:
// its devices started (usbstor), its file read, a file written to it (in
// the image afterwards). Takes about 10 minutes.
//
// Env: XP_IMAGE (retro-gaming-site/windowsxp/windowsxp_multidisk_C_4G.img,
// opened read only: writes stay in memory), XP_OUT (build/xp-usb: the
// screenshots), TEST_RELEASE_BUILD, XP_MEMORY_MB (512), XP_USB_CONTROLLER (uhci;
// ehci: EHCI with its companions, the USB disk at high speed).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync as deflate_sync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { MemoryDisk, ReadOnlyOverlayDisk, make_fat16, read_fat16 } from "../smp/disk_fixture.mjs";
import { site_directory } from "../lib/site.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const image_path = path.resolve(process.env.XP_IMAGE || path.join(site_directory(root), "windowsxp/windowsxp_multidisk_C_4G.img"));
const out = path.resolve(process.env.XP_OUT || path.join(root, "build/xp-usb"));
fs.mkdirSync(out, { recursive: true });
const image_mtime = fs.statSync(image_path).mtimeMs;
const CONTROLLER = process.env.XP_USB_CONTROLLER || "uhci";
const started = performance.now();
const elapsed = () => Math.round((performance.now() - started) / 1000);

// USBCHECK.EXE, 32-bit and without the CRT, as tests/x64/windows_boot.mjs builds it
const check = path.join(out, "USBCHECK.EXE");
const built = spawnSync("i686-w64-mingw32-gcc", ["-Os", "-nostdlib", "-fno-builtin", "-fno-stack-protector", "-mno-stack-arg-probe",
    "-Wl,--entry,_entry@0", "-Wl,--subsystem,console", "-o", check, path.join(root, "tests/x64/windows_usb.c"),
    "-lkernel32", "-luser32", "-lsetupapi", "-lcfgmgr32"], { encoding: "utf8" });
assert.equal(built.status, 0, built.stderr);
const tools = new MemoryDisk(make_fat16({ "USB.CMD": Buffer.from("@echo off\r\nstart %~d0\\USBCHECK.EXE\r\n"), "USBCHECK.EXE": fs.readFileSync(check) }));
const result_text = () => { const bytes = read_fat16(tools.bytes, "USB.TXT"); return bytes ? Buffer.from(bytes).toString("ascii") : ""; };
// the USB disk (another disk signature and volume serial than the tools disk's)
const usb_disk = make_fat16({ "USBDISK.TXT": Buffer.from("v86 USB disk check\r\n") });
new DataView(usb_disk.buffer).setUint32(440, 0x5B2026C3, true);
new DataView(usb_disk.buffer).setUint32(63 * 512 + 39, 0x5B2026C3, true);

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const vm = new V86({
    bios: { url: root + "bios/seabios.bin" },
    vga_bios: { url: root + "bios/vgabios.bin" },
    hda: new ReadOnlyOverlayDisk(image_path),
    hdb: tools,
    memory_size: (+process.env.XP_MEMORY_MB || 512) * 1048576,
    vram_size: 16 << 20,
    graphics_adapter: "bochs_vga",
    acpi: false,
    net_device: { type: "none" },
    usb: { controller: CONTROLLER, tablet: true, mass_storage: [{ id: "stick", image: { buffer: usb_disk.buffer } }] },
    autostart: true,
    log_level: 0,
});
const timeout = setTimeout(() => { console.log("Timeout"); process.exit(1); }, 1800 * 1000);
let tablet_active = false;
vm.add_listener("usb-tablet-active", value => { tablet_active = value; });
await new Promise(resolve => vm.add_listener("emulator-ready", resolve));
const cpu = vm.v86.cpu;

// The screen (bochs_vga's VBE mode), as a PNG in XP_OUT
function frame()
{
    const vga = cpu.devices.vga;
    if(!vga.svga_enabled || ![16, 24, 32].includes(vga.svga_bpp)) return null;
    const width = vga.svga_width, height = vga.svga_height, bytes_per = vga.svga_bpp / 8;
    const memory = new Uint8Array(cpu.wasm_memory.buffer, vga.svga_memory.byteOffset, vga.vga_memory_size);
    const stride = width * 3 + 1, raw = Buffer.alloc(stride * height), offset = vga.svga_offset * bytes_per;
    for(let y = 0; y < height; y++) for(let x = 0; x < width; x++)
    {
        const from = offset + (y * width + x) * bytes_per, to = y * stride + 1 + x * 3;
        if(bytes_per === 2)
        {
            const v = memory[from] | memory[from + 1] << 8;
            raw[to] = (v >> 11 & 31) << 3; raw[to + 1] = (v >> 5 & 63) << 2; raw[to + 2] = (v & 31) << 3;
        }
        else { raw[to] = memory[from + 2]; raw[to + 1] = memory[from + 1]; raw[to + 2] = memory[from]; }
    }
    return { width, height, raw };
}
function save(name, f)
{
    const chunk = (tag, data) =>
    {
        const body = Buffer.concat([Buffer.from(tag), data]), b = Buffer.alloc(data.length + 12);
        b.writeUInt32BE(data.length);
        body.copy(b, 4);
        b.writeUInt32BE(crc32(body), b.length - 4);
        return b;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(f.width);
    header.writeUInt32BE(f.height, 4);
    header[8] = 8;
    header[9] = 2;
    fs.writeFileSync(path.join(out, name), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
        chunk("IDAT", deflate_sync(f.raw)), chunk("IEND", Buffer.alloc(0))]));
}

// The desktop: a graphics mode whose picture stays the same for 20 s
let last = null, same_since = 0;
for(;;)
{
    await delay(2000);
    const f = frame();
    const key = f && f.width + "x" + f.height + ":" + crc32(f.raw);
    if(key !== last) { last = key; same_since = performance.now(); if(f) save("screen.png", f); continue; }
    if(f && elapsed() > 60 && performance.now() - same_since > 20000) break;
}
let screen = frame();
save("desktop.png", screen);
console.log("desktop " + screen.width + "x" + screen.height + " at " + elapsed() + " s; the tablet " + (tablet_active ? "in use" : "not in use"));

const scans = {};
for(const [letters, codes] of [["1234567890", [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]], ["qwertyuiop", [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]],
    ["asdfghjkl", [30, 31, 32, 33, 34, 35, 36, 37, 38]], ["zxcvbnm", [44, 45, 46, 47, 48, 49, 50]]])
{
    [...letters].forEach((letter, i) => { scans[letter] = codes[i]; });
}
Object.assign(scans, { " ": 57, ".": 52, "/": 53, "\\": 43 });
const shifted = { ":": 39, "%": 6, "(": 10, ")": 11, "@": 3 };
async function type(text)
{
    for(const ch of text)
    {
        const code = shifted[ch] || scans[ch];
        assert.ok(code, "scan code for " + JSON.stringify(ch));
        await vm.keyboard_send_scancodes(shifted[ch] ? [42, code, code | 128, 170] : [code, code | 128], 30);
        await delay(60);
    }
}
const keys = { enter: [28, 156], down: [0xE0, 0x50, 0xE0, 0xD0], up: [0xE0, 0x48, 0xE0, 0xC8], tab: [15, 143], space: [57, 185],
    esc: [1, 129], "alt+n": [56, 49, 177, 184], "alt+f4": [56, 62, 190, 184] };

// XP_CONTROL=<file>: commands from that file, one per line, until "go" (to
// drive dialogs by hand): a key name of `keys`, "type <text>", "wait <s>";
// each batch ends with a screenshot (control.png)
if(process.env.XP_CONTROL)
{
    console.log("waiting for commands in " + process.env.XP_CONTROL);
    for(let go = false; !go;)
    {
        await delay(1000);
        if(!fs.existsSync(process.env.XP_CONTROL)) continue;
        const lines = fs.readFileSync(process.env.XP_CONTROL, "utf8").split("\n").map(line => line.trim()).filter(Boolean);
        fs.unlinkSync(process.env.XP_CONTROL);
        for(const line of lines)
        {
            if(line === "go") go = true;
            else if(line.startsWith("type ")) await type(line.slice(5));
            else if(line.startsWith("wait ")) await delay(1000 * +line.slice(5));
            else if(keys[line]) await vm.keyboard_send_scancodes(keys[line], 30);
            else console.log("unknown command " + line);
            await delay(300);
        }
        await delay(1000);
        save("control.png", frame());
        console.log("done: " + lines.join("; ") + " (tablet " + (tablet_active ? "in use" : "not in use") + ")");
    }
}

// The image has no driver for bochs_vga's display: XP's Found New Hardware
// wizard asks for one, and installs the USB devices' drivers only after it
// (it takes one new device at a time). Cancelled, until the tablet is in use.
for(let i = 0; !tablet_active; i++)
{
    assert.ok(i < 6, "the guest did not configure the tablet");
    await vm.keyboard_send_scancodes(keys.esc, 30);
    for(const limit = performance.now() + 30000; !tablet_active && performance.now() < limit;) await delay(1000);
}
console.log("the tablet in use at " + elapsed() + " s");

async function wait_file(text, seconds)
{
    for(const limit = performance.now() + seconds * 1000; performance.now() < limit;)
    {
        if(result_text().includes(text)) return true;
        await delay(2000);
        const f = frame();
        if(f) save("screen.png", f);
    }
    return false;
}

// Win+R, USB.CMD from the tools disk. Having installed the drivers, XP may
// ask to restart (Yes/No) and take the keys meant for the Run dialog: No
// first (Alt+N does nothing on the desktop); an error box after keys went
// astray takes Enter; then again.
for(let attempt = 0; ; attempt++)
{
    assert.ok(attempt < 3, "USB.TXT without READY: " + JSON.stringify(result_text()));
    await delay(attempt ? 2000 : 20000);
    await vm.keyboard_send_scancodes(keys["alt+n"], 30);
    await delay(2000);
    await vm.keyboard_send_scancodes([0xE0, 0x5B, 0x13, 0x93, 0xE0, 0xDB], 30);
    await delay(3000);
    await type("cmd /c for %d in (d e f g h) do @if exist %d:\\usb.cmd %d:\\usb.cmd");
    await vm.keyboard_send_scancodes(keys.enter, 30);
    if(await wait_file("READY", 240)) break;
    save("attempt-" + attempt + ".png", frame());
    await vm.keyboard_send_scancodes(keys.enter, 30);
}
screen = frame();
const points = [[0, 0], [screen.width - 1, 0], [0, screen.height - 1], [screen.width - 1, screen.height - 1],
    [screen.width >> 1, screen.height >> 1]];
for(let i = 0; i < 5; i++) for(let j = 0; j < 5; j++) points.push([Math.round(i * (screen.width - 1) / 4), Math.round(j * (screen.height - 1) / 4)]);
for(const [x, y] of points)
{
    vm.bus.send("mouse-absolute", [x, y, screen.width, screen.height]);
    await delay(2500);
}
// (USBCHECK.EXE stops logging there)
vm.bus.send("mouse-absolute", [3, 5, screen.width, screen.height]);
assert.ok(await wait_file("END", 300), "USB.TXT without END");
save("end.png", frame());

const text = result_text();
console.log(text.split("\r\n").filter(line => !line.startsWith("POS")).join("\n"));
const devices = text.split("\r\n").filter(line => line.startsWith("DEVICE"));
const controllers = CONTROLLER === "ehci" ? ["PCI\\VEN_8086&DEV_293A", "PCI\\VEN_8086&DEV_2934", "PCI\\VEN_8086&DEV_2935", "PCI\\VEN_8086&DEV_2936",
    "USB\\ROOT_HUB20"] : ["PCI\\VEN_8086&DEV_7020"];
for(const id of [...controllers, "USB\\ROOT_HUB", "USB\\VID_0627&PID_0001", "HID\\VID_0627&PID_0001", "USB\\VID_46F4&PID_0001", "USBSTOR\\DISK"])
{
    // (every one of them: the root hubs of the EHCI and the companions)
    const lines = devices.filter(d => d.startsWith("DEVICE " + id));
    assert.ok(lines.length, id + " present");
    for(const line of lines) assert.match(line, /error=0 .*\| started/, line);
}
// the USB disk: its file read, FROMWIN.TXT written into the image
assert.match(text, /^DISK [D-Z]:\\ v86 USB disk check\r?$/m);
assert.match(text, /^DISK WRITTEN\r?$/m);
const written = read_fat16(usb_disk, "FROMWIN.TXT");
assert.ok(written && Buffer.from(written).toString("ascii").startsWith("written by Windows"), "FROMWIN.TXT in the USB disk's image");
console.log("USB disk: USBDISK.TXT read, FROMWIN.TXT in the image");
const usb_devices = await vm.usb_devices();
console.log("USB devices: " + usb_devices.map(d => d.id + " " + d.controller + " " + d.speed + " Mbit/s").join(", "));
if(CONTROLLER === "ehci")
{
    assert.deepEqual(usb_devices.map(d => [d.id, d.controller, d.speed]), [["tablet", "uhci", 12], ["stick", "ehci", 480]]);
}

// The positions in order: each point seen (within a pixel), held for at
// least two samples
const runs = [];
for(const [, x, y] of text.matchAll(/^POS (-?\d+) (-?\d+)/gm))
{
    const run = runs[runs.length - 1];
    if(run && run.x === +x && run.y === +y) run.n++;
    else runs.push({ x: +x, y: +y, n: 1 });
}
let at = 0, worst = 0;
const missing = [];
for(const [x, y] of points)
{
    const found = runs.findIndex((r, i) => i >= at && Math.abs(r.x - x) <= 1 && Math.abs(r.y - y) <= 1 && r.n >= 2);
    if(found < 0) { missing.push(x + "," + y); continue; }
    worst = Math.max(worst, Math.abs(runs[found].x - x), Math.abs(runs[found].y - y));
    at = found + 1;
}
console.log("positions: " + (points.length - missing.length) + " of " + points.length + " seen, worst error " + worst + " px" +
    (missing.length ? ", missing " + missing.join(" ") : ""));
console.log("runs: " + runs.map(r => r.x + "," + r.y + "x" + r.n).join(" "));
assert.equal(fs.statSync(image_path).mtimeMs, image_mtime, "the image is unchanged");
// (a point the guest did not run during is no error of the tablet's: allow one)
assert.ok(missing.length <= 1, "missing positions: " + missing.join(" "));
clearTimeout(timeout);
await vm.destroy();
console.log("PASS");
process.exit(0);
