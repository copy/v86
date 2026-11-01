#!/usr/bin/env node
// Real XP concurrent process arenas, kill and foreign cleanup acceptance.
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
const out = path.resolve(process.env.D9WG_OWNER_OUT || root + "build/d3d-review/stage4c3-xp");
const image = process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img";
fs.mkdirSync(out, { recursive: true });
for(const api of ["d3d9", "d3d8", "ddraw"])
{
    fs.mkdirSync(out + "/" + api, { recursive: true });
    run("sh", [site + "/glbridge/" + api + "proxy/build.sh", out + "/" + api + "/" + api + ".dll"], { stdio: "pipe" });
}
run("sh", [site + "/glbridge/runtime/build.sh", out + "/runtime.a"], { stdio: "pipe" });
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
    "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/OWNER.EXE", site + "/glbridge/sample/d3d_multi_owner_test.c", out + "/runtime.a", "-luser32", "-lkernel32"], { stdio: "pipe" });
const fault = process.argv.includes("--map-exception");
const driver_env = { ...process.env };
if(fault)
{
    const helper = fs.readFileSync(site + "/glbridge/v86gl_driver/map_user.c", "utf8");
    fs.writeFileSync(out + "/map_fault.c", "__declspec(dllimport) void __stdcall ExRaiseStatus(long);\nstatic int raised;\n" +
        helper.replace("return map(mdl);", "if(!raised++) ExRaiseStatus((long)0xC000009AL);return map(mdl);"));
    driver_env.V86GL_MAP_USER_SOURCE = out + "/map_fault.c";
}
run("sh", [site + "/glbridge/v86gl_driver/build.sh", out + "/V86GL.SYS"], { stdio: "pipe", env: driver_env });
const before = fs.statSync(image);
const files = { "OWNER.EXE": fs.readFileSync(out + "/OWNER.EXE"),
    "V86GL.SYS": fs.readFileSync(out + "/V86GL.SYS"),
    "OWNER.CMD": Buffer.from("@echo off\r\nsc stop v86gl\r\nsc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys\r\ncopy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys\r\nsc start v86gl\r\nif errorlevel 1 goto failed\r\nsc qc v86gl >%~d0\\SERVICE.TXT\r\n" +
        (fault ? "set D9WG_MAP_EXCEPTION=1\r\n" : "") + "%~d0\\owner.exe\r\nexit /b\r\n:failed\r\necho FAIL start current v86gl driver >%~d0\\OWNER.TXT\r\n") };
for(const api of ["d3d9", "d3d8", "ddraw"]) files[api.toUpperCase() + ".DLL"] = fs.readFileSync(out + "/" + api + "/" + api + ".dll");
const tools = new MemoryDisk(make_fat16(files)), disk = new ReadOnlyOverlayDisk(image);
const require = create_require(import.meta.url), { createV86GLDevice: create_device } = require("../../src/browser/glbridge/v86gl_device.js");
const handlers = [null, null];
const end = (self, other) => ({ remote: false, post(message) { handlers[other]?.(message); }, listen(handler) { handlers[self] = handler; } });
const channel = { device: end(0, 1), host: end(1, 0) };
let batches = 0;const releases = [], owner_batches = [], timeline = [];
const descriptor = create_device(channel.device);
channel.host.listen(message => {
    if(message.type === "batch") {
        batches++;owner_batches.push(message.ownerToken || 0);timeline.push(["batch", message.ownerToken || 0]);
        channel.host.post({ type: "done", id: message.id });
    }
    else if(message.type === "released") { releases.push(message.ownerToken);timeline.push(["release", message.ownerToken]); }
});
channel.host.post({ type: "available", value: true });
const { V86 } = await import("../../src/main.js");
const vm = new V86({ bios: { url: root + "bios/seabios.bin" }, vga_bios: { url: root + "bios/vgabios.bin" },
    hda: disk, hdb: tools, memory_size: 512 << 20, vram_size: 16 << 20,
    graphics_adapter: "bochs_vga", acpi: false, net_device: { type: "none" },
    virtio_devices: [descriptor], autostart: true, disable_speaker: true, boot_order: 0x213, log_level: 0 });
const started = performance.now(), elapsed = () => Math.round((performance.now() - started) / 1000);
const result_text = () => { const data = read_fat16(tools.bytes, "OWNER.TXT");return data ? Buffer.from(data).toString("ascii") : ""; };
const child_text = name => { const data = read_fat16(tools.bytes, name);return data ? Buffer.from(data).toString("ascii") : ""; };
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
        for(let cancel = 0; cancel < 3; cancel++) { await vm.keyboard_send_scancodes([1, 129], 30);await delay(1000); }
        await vm.keyboard_send_scancodes([0xE0, 0x5B, 0x13, 0x93, 0xE0, 0xDB], 30);await delay(2000);
        await vm.keyboard_send_text("cmd /c for %d in (d e f g h i j k) do @if exist %d:\\owner.cmd %d:\\owner.cmd", 30);
        await vm.keyboard_send_scancodes([28, 156], 30);
        for(let poll = 0; poll < 180; poll++)
        {
            await delay(1000);const text = result_text();
            if(text.includes("FAIL ") || child_text("OWNER_A.TXT").includes("FAIL ") || child_text("OWNER_B.TXT").includes("FAIL "))
                throw new Error(text.trim() + "\n" + child_text("OWNER_A.TXT") + child_text("OWNER_B.TXT"));
            if(text.includes("PASS all real XP")) break;
            if(poll === 29 && !text && !child_text("OWNER_A.TXT") && !child_text("OWNER_B.TXT")) break;
            if(poll % 10 === 9) console.log("waiting", elapsed(), "s", JSON.stringify({ parent: text.trim(), a: child_text("OWNER_A.TXT"), b: child_text("OWNER_B.TXT") }));
        }
    }
    const text = result_text();assert(text.includes("PASS all real XP"), "Owner probe did not finish: " + text);
    assert.equal(releases.length, 3, "kill A, foreign last GL cleanup and normal B unload each release once");
    assert.equal(releases.filter(owner => owner === 0).length, 1);
    const positive = releases.filter(owner => owner > 0);assert.equal(new Set(positive).size, 2);
    assert.equal(new Set(owner_batches.filter(owner => owner > 0)).size, 2, "both real processes submitted through distinct arenas");
    const killed_at = timeline.findIndex(([kind, owner]) => kind === "release" && owner > 0);
    assert(timeline.slice(killed_at + 1).some(([kind, owner]) => kind === "batch" && owner > 0 && owner !== positive[0]), "B submits after A exits");
    assert.equal(owner_batches.filter(owner => owner === 0).length, 3, "legacy GL transport survives two live owners and A's kill");
    assert(child_text("OWNER_B.TXT").includes("PASS foreign duplicated legacy handle closed"));
    assert(child_text("OWNER_B.TXT").includes("PASS dead owner's final duplicate closed"));
    const legacy_at = timeline.map(([kind, owner], at) => kind === "batch" && owner === 0 ? at : -1).filter(at => at >= 0);
    assert(killed_at < legacy_at[2], "process exit revokes A before the final duplicate in B closes");
    if(fault) assert(text.includes("PASS real kernel mapping exception caught"));
    const after = fs.statSync(image);assert.equal(after.mtimeMs, before.mtimeMs);assert.equal(after.size, before.size);
    fs.writeFileSync(out + "/owner-xp-result.json", JSON.stringify({ status: "PASS", seconds: elapsed(), batches, releases, ownerBatches: owner_batches, timeline, mappingExceptionInjected: fault, text, diskWrites: "RAM sector overlay only", rendering: "not exercised" }, null, 2) + "\n");
    save_frame("owner-complete.png", frame());
    console.log(JSON.stringify({ status: "PASS", seconds: elapsed(), batches, releases, checks: text.trim().split(/\r?\n/) }));
}
catch(error)
{
    save_frame("owner-failure.png", frame());
    const children = { service: child_text("SERVICE.TXT"), a: child_text("OWNER_A.TXT"), b: child_text("OWNER_B.TXT") };
    fs.writeFileSync(out + "/owner-failure.json", JSON.stringify({ text: result_text(), children, timeline }, null, 2));
    console.error("Child evidence", JSON.stringify(children));throw error;
}
finally
{
    await vm.stop();await vm.destroy();fs.closeSync(disk.fd);
}
