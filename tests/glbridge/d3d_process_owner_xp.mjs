#!/usr/bin/env node
// Real XP loader/driver acceptance for the process owner, without rendering.
// The renderer endpoint acknowledges batches; no drawing API/pixel claim is
// made. Disk writes stay in RAM. Requires the user's installed-driver image.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync as run } from "node:child_process";
import { createRequire as create_require } from "node:module";
import { fileURLToPath as file_url_to_path } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync as deflate_sync, crc32 } from "node:zlib";
import { MemoryDisk, ReadOnlyOverlayDisk, make_fat16, read_fat16 } from "../smp/disk_fixture.mjs";
import { site_directory } from "../lib/site.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_OWNER_OUT || root + "build/d3d-review/stage4b1");
const image = process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img";
fs.mkdirSync(out, { recursive: true });
for(const api of ["d3d9", "d3d8", "ddraw"])
{
    fs.mkdirSync(out + "/" + api, { recursive: true });
    run("sh", [site + "/glbridge/" + api + "proxy/build.sh", out + "/" + api + "/" + api + ".dll"], { stdio: "pipe" });
}
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
    "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/OWNER.EXE", site + "/glbridge/sample/d3d_process_owner_test.c", "-luser32", "-lkernel32"], { stdio: "pipe" });
const before = fs.statSync(image);
const files = { "OWNER.EXE": fs.readFileSync(out + "/OWNER.EXE"),
    "OWNER.CMD": Buffer.from("@echo off\r\nsc start v86gl\r\n%~d0\\owner.exe\r\n") };
for(const api of ["d3d9", "d3d8", "ddraw"]) files[api.toUpperCase() + ".DLL"] = fs.readFileSync(out + "/" + api + "/" + api + ".dll");
const tools = new MemoryDisk(make_fat16(files)), disk = new ReadOnlyOverlayDisk(image);
const require = create_require(import.meta.url), { createV86GLDevice: create_device } = require("../../src/browser/glbridge/v86gl_device.js");
const handlers = [null, null];
const end = (self, other) => ({ remote: false, post(message) { handlers[other]?.(message); }, listen(handler) { handlers[self] = handler; } });
const channel = { device: end(0, 1), host: end(1, 0) };
let batches = 0, releases = 0;
const descriptor = create_device(channel.device);
channel.host.listen(message => {
    if(message.type === "batch") { batches++;channel.host.post({ type: "done", id: message.id }); }
    else if(message.type === "released") releases++;
});
channel.host.post({ type: "available", value: true });
const { V86 } = await import("../../src/main.js");
const vm = new V86({ bios: { url: root + "bios/seabios.bin" }, vga_bios: { url: root + "bios/vgabios.bin" },
    hda: disk, hdb: tools, memory_size: 512 << 20, vram_size: 16 << 20,
    graphics_adapter: "bochs_vga", acpi: false, net_device: { type: "none" },
    virtio_devices: [descriptor], autostart: true, disable_speaker: true, boot_order: 0x213, log_level: 0 });
const started = performance.now(), elapsed = () => Math.round((performance.now() - started) / 1000);
const result_text = () => { const data = read_fat16(tools.bytes, "OWNER.TXT");return data ? Buffer.from(data).toString("ascii") : ""; };
function frame()
{
    const vga = vm.v86.cpu.devices.vga;
    if(!vga.svga_enabled || ![16, 24, 32].includes(vga.svga_bpp)) return null;
    const width = vga.svga_width, height = vga.svga_height, bpp = vga.svga_bpp / 8;
    const pixels = new Uint8Array(vm.v86.cpu.wasm_memory.buffer, vga.svga_memory.byteOffset, vga.vga_memory_size);
    const raw = Buffer.alloc(height * (width * 3 + 1)), offset = vga.svga_offset * bpp;
    for(let y = 0; y < height; y++) for(let x = 0; x < width; x++)
    {
        const from = offset + (y * width + x) * bpp, to = y * (width * 3 + 1) + 1 + x * 3;
        if(bpp === 2) { const value = pixels[from] | pixels[from + 1] << 8;raw[to] = (value >> 11 & 31) << 3;raw[to + 1] = (value >> 5 & 63) << 2;raw[to + 2] = (value & 31) << 3; }
        else { raw[to] = pixels[from + 2];raw[to + 1] = pixels[from + 1];raw[to + 2] = pixels[from]; }
    }
    return { width, height, raw };
}
function save_frame(name, picture)
{
    if(!picture) return;
    const chunk = (tag, data) => {
        const body = Buffer.concat([Buffer.from(tag), data]), result = Buffer.alloc(data.length + 12);
        result.writeUInt32BE(data.length);body.copy(result, 4);result.writeUInt32BE(crc32(body), body.length + 4);return result;
    };
    const header = Buffer.alloc(13);header.writeUInt32BE(picture.width);header.writeUInt32BE(picture.height, 4);header[8] = 8;header[9] = 2;
    fs.writeFileSync(out + "/" + name, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflate_sync(picture.raw)), chunk("IEND", Buffer.alloc(0))]));
}
try
{
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    let last = null, stable_since = performance.now();
    for(; elapsed() < 210;)
    {
        await delay(2000);
        const picture = frame(), key = picture && picture.width + "x" + picture.height + ":" + crc32(picture.raw);
        if(key !== last) { last = key;stable_since = performance.now(); }
        if(elapsed() % 10 < 2) console.log("XP boot", elapsed(), "s", picture ? picture.width + "x" + picture.height : "VGA");
        if(picture && elapsed() >= 60 && performance.now() - stable_since > 20000) break;
    }
    save_frame("owner-desktop.png", frame());
    for(let attempt = 0; attempt < 3 && !result_text().includes("PASS all real XP"); attempt++)
    {
        console.log("launch owner probe", elapsed(), "s", "attempt", attempt + 1);
        await vm.keyboard_send_scancodes([1, 129], 30);await delay(1000);
        await vm.keyboard_send_scancodes([0xE0, 0x5B, 0x13, 0x93, 0xE0, 0xDB], 30);await delay(2000);
        await vm.keyboard_send_text("cmd /c for %d in (d e f g h i j k) do @if exist %d:\\owner.cmd %d:\\owner.cmd", 30);
        await vm.keyboard_send_scancodes([28, 156], 30);
        for(let poll = 0; poll < 60; poll++)
        {
            await delay(1000);const text = result_text();
            if(text.includes("FAIL ")) throw new Error(text.trim());
            if(text.includes("PASS all real XP")) break;
            if(poll % 10 === 9) console.log("waiting", elapsed(), "s", JSON.stringify(text.trim()));
        }
    }
    const text = result_text();assert(text.includes("PASS all real XP"), "Owner probe did not finish: " + text);
    assert.equal(releases, 2, "two complete unload orders must release exactly two driver owners");
    assert(batches >= 2, "driver did not submit the process sessions");
    const after = fs.statSync(image);assert.equal(after.mtimeMs, before.mtimeMs);assert.equal(after.size, before.size);
    fs.writeFileSync(out + "/owner-xp-result.json", JSON.stringify({ status: "PASS", seconds: elapsed(), batches, releases, text, diskWrites: "RAM sector overlay only", rendering: "not exercised" }, null, 2) + "\n");
    save_frame("owner-complete.png", frame());
    console.log(JSON.stringify({ status: "PASS", seconds: elapsed(), batches, releases, checks: text.trim().split(/\r?\n/) }));
}
catch(error)
{
    save_frame("owner-failure.png", frame());throw error;
}
finally
{
    await vm.stop();await vm.destroy();fs.closeSync(disk.fd);
}
