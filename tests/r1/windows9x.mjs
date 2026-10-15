#!/usr/bin/env node
// Windows 98 regressions for the release gate (tools/release_gate.mjs), against
// a baseline build, with the configuration retro-gaming-site uses (256 MiB,
// 16 MiB video memory, no ACPI, NE2K, the v86gl PCI device, C: plus a game
// disk). Every disk is opened read-only (guest writes stay in a RAM overlay).
//
//   BUILD=current  build/libv86.mjs + build/v86.wasm (default)
//   BUILD=site     retro-gaming-site's libv86.js + v86.wasm (the production
//                  build of 2026-09-05/06, before the ACPI/x64/multi-core work)
//   SCENARIO=boot            cold boot to the desktop (taskbar), time it (this C:
//                            image stops at the MS-DOS mode prompt: WIN and Enter
//                            restart it in normal mode)
//   SCENARIO=state:<game>    restore the site's saved state of <game> with its
//                            game disk, run RUN_S (60) seconds: the CPU keeps
//                            retiring instructions, the screen has content, no
//                            emulator error
//
// SITE (../retro-gaming-site), OUT (build/r1-windows9x/<build>-<scenario>),
// TIMEOUT_S (600 for boot). Prints R1_WIN9X_PASS / R1_WIN9X_FAIL and a JSON line.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire as create_require } from "node:module";
import { createHash as create_hash } from "node:crypto";
import { deflateSync as deflate_sync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ReadOnlyOverlayDisk } from "../smp/disk_fixture.mjs";
import { site_directory } from "../lib/site.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const site = path.resolve(process.env.SITE || site_directory(root)) + "/";
const build = process.env.BUILD || "current";
const scenario = process.env.SCENARIO || "boot";
const out = path.resolve(process.env.OUT || path.join(root, "build/r1-windows9x", `${build}-${scenario.replace(":", "-")}`)) + "/";
fs.mkdirSync(out, { recursive: true });

const V86 = build === "site" ? create_require(import.meta.url)(site + "libv86.js").V86 :
    (await import(root + "build/libv86.mjs")).V86;
const wasm_path = build === "site" ? site + "v86.wasm" : root + "build/v86.wasm";
// The guest's v86gl driver finds its device; no renderer answers (the site's
// older libv86.js has the device built in)
const { createV86GLDevice: create_v86gl_device } = create_require(import.meta.url)(root + "src/browser/glbridge/v86gl_device.js");
const v86gl = build === "site" ? { v86gl_pci: { port: 0xF100, maxBatchBytes: 16 * 1024 * 1024 } } :
    { virtio_devices: [create_v86gl_device({ remote: false, post() {}, listen() {} })] };
const bios_dir = build === "site" ? site + "bios/" : root + "bios/";

const system_disk = site + "windows98/windows98multidisk/windows98hdd_C_512MB.img";
const game = scenario.startsWith("state:") ? scenario.slice(6) : null;
const game_disk = game && site + `game/${game}.img`;
const state_file = game && site + `windows98/states/windows98_audio_vga_2d_multidisk_${game}.bin.zst`;
for(const file of [system_disk, game_disk, state_file].filter(Boolean)) assert.ok(fs.existsSync(file), file);
const image_mtimes = [system_disk, game_disk].filter(Boolean).map(file => fs.statSync(file).mtimeMs);

const disks = { hda: new ReadOnlyOverlayDisk(system_disk), hdb: game_disk ? new ReadOnlyOverlayDisk(game_disk) : undefined };
const emulator = new V86({
    graphics_adapter: "bochs_vga",
    wasm_path, bios: { url: bios_dir + "seabios.bin" }, vga_bios: { url: bios_dir + "vgabios.bin" },
    memory_size: 256 << 20, vram_size: 16 << 20, acpi: false, boot_order: 0x213,
    hda: disks.hda, ...(disks.hdb ? { hdb: disks.hdb } : {}),
    net_device: { type: "ne2k" }, preserve_mac_from_state_image: false, mac_address_translation: true,
    ...v86gl,
    ...(state_file ? { initial_state: { buffer: fs.readFileSync(state_file).buffer } } : {}),
    autostart: false, log_level: 0,
});
const errors = [];
emulator.add_listener("emulator-error", error => errors.push(String(error)));
const t_load = performance.now();
await Promise.race([new Promise(resolve => emulator.add_listener("emulator-loaded", resolve)),
    // (unref'd: this timer must not keep node alive after the run)
    delay(300000, undefined, { ref: false }).then(() => { throw new Error("load timeout"); })]);
const load_s = (performance.now() - t_load) / 1000;
const cpu = emulator.v86.cpu, vga = cpu.devices.vga;

// the screen as RGB rows: VBE (8/15/16/24/32 bpp) or the VGA's pixel buffer
function screen()
{
    if(vga.svga_enabled && vga.svga_width && vga.svga_height)
    {
        const width = vga.svga_width, height = vga.svga_height, bpp = vga.svga_bpp, bytes = bpp === 15 ? 2 : bpp / 8;
        const rgb = Buffer.alloc(width * height * 3), memory = vga.svga_memory;
        for(let i = 0; i < width * height; i++)
        {
            const at = vga.svga_offset * bytes + i * bytes;
            let r, g, b;
            if(bytes === 1) { const c = vga.vga256_palette[memory[at]]; r = c >> 16 & 255; g = c >> 8 & 255; b = c & 255; }
            else if(bytes === 2)
            {
                const v = memory[at] | memory[at + 1] << 8;
                if(bpp === 15) { r = (v >> 10 & 31) << 3; g = (v >> 5 & 31) << 3; b = (v & 31) << 3; }
                else { r = (v >> 11 & 31) << 3; g = (v >> 5 & 63) << 2; b = (v & 31) << 3; }
            }
            else { r = memory[at + 2]; g = memory[at + 1]; b = memory[at]; }
            rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
        }
        return { width, height, rgb, mode: `vbe ${width}x${height}x${bpp}` };
    }
    if(vga.graphical_mode && vga.screen_width && vga.screen_height)
    {
        const width = vga.screen_width, height = vga.screen_height, rgb = Buffer.alloc(width * height * 3);
        const eight_bit = vga.attribute_mode & 0x40;
        for(let y = 0; y < height; y++) for(let x = 0; x < width; x++)
        {
            const index = vga.pixel_buffer[y * vga.virtual_width + x];
            const color = vga.vga256_palette[eight_bit ? index : vga.dac_map[index & vga.color_plane_enable]];
            const at = (y * width + x) * 3;
            rgb[at] = color >> 16 & 255; rgb[at + 1] = color >> 8 & 255; rgb[at + 2] = color & 255;
        }
        return { width, height, rgb, mode: `vga ${width}x${height}` };
    }
    return null;
}
function png(shot)
{
    const { width, height, rgb } = shot, stride = width * 3 + 1, raw = Buffer.alloc(stride * height);
    for(let y = 0; y < height; y++) rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
    const crc = data => { let c = ~0; for(const byte of data) { c ^= byte; for(let i = 0; i < 8; i++) c = c & 1 ? 0xEDB88320 ^ c >>> 1 : c >>> 1; } return ~c >>> 0; };
    const chunk = (name, data) => { const body = Buffer.concat([Buffer.from(name), data]), b = Buffer.alloc(data.length + 12);
        b.writeUInt32BE(data.length); body.copy(b, 4); b.writeUInt32BE(crc(body), b.length - 4); return b; };
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
        chunk("IDAT", deflate_sync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function text_screen()
{
    if(vga.graphical_mode) return "";
    return Array.from({ length: 25 }, (_, row) => Array.from({ length: 80 }, (_, col) => {
        const c = vga.vga_memory[(row * 80 + col) * 2];
        return c >= 32 && c < 127 ? String.fromCharCode(c) : " ";
    }).join("").trimEnd()).join("\n").trim();
}
const colors = shot => { const set = new Set(); for(let i = 0; i < shot.rgb.length; i += 3 * 37) set.add(shot.rgb.readUIntBE(i, 3)); return set.size; };
// the Windows 9x taskbar: a light gray band (192, 192, 192) along the bottom
function taskbar(shot)
{
    let gray = 0, samples = 0;
    for(let y = shot.height - 22; y < shot.height - 4; y += 3) for(let x = 0; x < shot.width; x += 7)
    {
        const at = (y * shot.width + x) * 3;
        samples++;
        if(Math.abs(shot.rgb[at] - 192) < 12 && Math.abs(shot.rgb[at + 1] - 192) < 12 && Math.abs(shot.rgb[at + 2] - 192) < 12) gray++;
    }
    return gray / samples;
}
const retired = () => Number(cpu.wm.exports["core_statistics_get"]?.(0, 0) ?? 0) || emulator.get_instruction_counter();

const result = { build, scenario, load_s, errors };
const t0 = performance.now();
emulator.run();
let passed = false;
try
{
    if(scenario === "boot")
    {
        const deadline = t0 + (+process.env.TIMEOUT_S || 600) * 1000;
        let last_hash = "", stable_since = 0, shots = 0, last_shot = 0, typed_win = false, confirmed = false;
        for(;;)
        {
            await delay(1000);
            if(errors.length) throw new Error("emulator error: " + errors[0]);
            // this image was last left in MS-DOS mode: start Windows from its prompt
            const text = text_screen();
            if(!typed_win && /C:\\WINDOWS>\s*$/.test(text))
            {
                typed_win = true;
                result.dos_prompt_s = +((performance.now() - t0) / 1000).toFixed(1);
                emulator.keyboard_send_text("win\n");
            }
            // "... return to normal mode, to run Windows applications again [Enter=Y,Esc=N]?"
            if(!confirmed && /return to normal mode/.test(text))
            {
                confirmed = true;
                emulator.keyboard_send_scancodes([0x1C, 0x9C]);
            }
            const shot = screen();
            if(shot)
            {
                const hash = create_hash("sha1").update(shot.rgb).digest("hex");
                if(hash !== last_hash) { last_hash = hash; stable_since = performance.now(); }
                if(performance.now() - last_shot > 30000) { last_shot = performance.now(); fs.writeFileSync(out + `screen-${String(++shots).padStart(2, "0")}.png`, png(shot)); }
                // the desktop: the taskbar, and the screen settled for 5 s
                if(shot.width >= 640 && taskbar(shot) > 0.6 && performance.now() - stable_since > 5000)
                {
                    result.desktop_s = +((stable_since - t0) / 1000).toFixed(1);
                    result.mode = shot.mode;
                    result.colors = colors(shot);
                    fs.writeFileSync(out + "desktop.png", png(shot));
                    passed = true;
                    break;
                }
            }
            if(performance.now() > deadline)
            {
                if(shot) fs.writeFileSync(out + "timeout.png", png(shot));
                else result.text = text_screen();
                throw new Error(`no desktop within ${(deadline - t0) / 1000} s (screen ${shot?.mode || "text"})`);
            }
        }
    }
    else
    {
        const run_s = +process.env.RUN_S || 60;
        const samples = [];
        for(let s = 0; s < run_s; s += 10)
        {
            const before = retired();
            await delay(10000);
            if(errors.length) throw new Error("emulator error: " + errors[0]);
            samples.push(retired() - before);
        }
        const shot = screen();
        if(shot) fs.writeFileSync(out + "final.png", png(shot));
        result.mips = samples.map(n => +(n / 1e7).toFixed(1));
        result.mode = shot?.mode || "text";
        result.colors = shot ? colors(shot) : 0;
        assert.ok(samples.every(n => n > 0), "the CPU retires instructions in every 10 s: " + samples);
        assert.ok(shot && result.colors > 4, "the screen has content: " + result.mode + ", colors " + result.colors);
        passed = true;
    }
}
catch(error)
{
    result.error = String(error.message || error);
}
finally
{
    result.wall_s = +((performance.now() - t0) / 1000).toFixed(1);
    await emulator.destroy();
    [system_disk, game_disk].filter(Boolean).forEach((file, i) => assert.equal(fs.statSync(file).mtimeMs, image_mtimes[i], "image unchanged: " + file));
    fs.writeFileSync(out + "result.json", JSON.stringify(result, null, 1));
    console.log((passed ? "R1_WIN9X_PASS " : "R1_WIN9X_FAIL ") + JSON.stringify(result));
    process.exitCode = passed ? 0 : 1;
}
