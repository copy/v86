#!/usr/bin/env node

// Windows booted through UEFI (docs/uefi.md, the plan's F1 "Windows UEFI
// 引导"): a Windows 8.1 x64 installer ISO (WIN_ISO, read only: its writes
// stay in memory) on Q35's SATA CD drive. OVMF's boot manager starts the
// CD's \EFI\BOOT\BOOTX64.EFI (from its El Torito EFI image), whose "Press
// any key to boot from CD or DVD" gets Enter; Windows Boot Manager, winload
// and Windows PE start; Setup's first page is on the screen, drawn through
// GOP's frame buffer at 1280x800 (the Bochs VGA): its background colour on
// most of the screen, the dialog's title bar and its Next button. A local
// test: the ISO is not part of the repository (about 90 s to Setup).
//
// WIN_ISO=<path> (default retro-gaming-site/windows8/windows81_full.iso
// beside the checkout), SHOW_SCREEN=<file.png>, TEST_RELEASE_BUILD=1.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";
import { ReadOnlyOverlayDisk } from "../smp/disk_fixture.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
// (beside the main checkout, or beside the checkout of build/<worktree>)
const ISO = path.resolve(process.env.WIN_ISO || ["../", "../../../"].map(up => path.join(ROOT, up, "retro-gaming-site/windows8/windows81_full.iso"))
    .find(candidate => fs.existsSync(candidate)) || "retro-gaming-site/windows8/windows81_full.iso");
if(!fs.existsSync(ISO))
{
    console.log("Skipped: no Windows installer ISO at " + ISO + " (WIN_ISO)");
    process.exit(0);
}
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const emulator = new V86({
    firmware: {
        type: "uefi",
        code: { url: ROOT + "bios/ovmf-code.fd" },
        vars: { url: ROOT + "bios/ovmf-vars.fd" },
    },
    cdrom: new ReadOnlyOverlayDisk(ISO),
    memory_size: 2048 * 1024 * 1024,
    graphics_adapter: "bochs_vga",
    cpu_type: "x86_64",
    machine_type: "q35",
    acpi: true,
    net_device: { type: "none" },
    autostart: true,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));
const cpu = emulator.v86.cpu;

let serial = "";
emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
const plain = text => text.replace(/\x1b\[[0-9;=?]*[A-Za-z]/g, "").replace(/\r/g, "");

/** The screen as RGB rows, or null in text mode */
function screen()
{
    const vga = cpu.devices.vga;
    if(!vga || !vga.svga_enabled || vga.svga_bpp !== 32) return null;
    const width = vga.svga_width, height = vga.svga_height;
    const memory = new Uint8Array(cpu.wasm_memory.buffer, cpu.mmio_ram_backing(vga.lfb_region) >>> 0, vga.vga_memory_size);
    const offset = vga.svga_offset * 4;
    const pixel = (x, y) => { const at = offset + (y * width + x) * 4; return [memory[at + 2], memory[at + 1], memory[at]]; };
    return { width, height, pixel };
}

/** Setup's first page: its background on most of the screen, the dialog's title bar, the Next button */
function setup_page(s)
{
    if(!s || s.width !== 1280 || s.height !== 800) return false;
    let background = 0, samples = 0;
    for(let y = 0; y < s.height; y += 8) for(let x = 0; x < s.width; x += 8)
    {
        const [r, g, b] = s.pixel(x, y);
        samples++;
        if(r === 24 && g === 0 && b === 82) background++;
    }
    const [tr, tg, tb] = s.pixel(500, 185);
    const [nr, ng, nb] = s.pixel(899, 602);
    return background / samples > 0.85 && tb > 200 && tr > 140 && tr < tb && nr > 200 && ng > 200 && nb > 200;
}

function save_png(s, file)
{
    const stride = s.width * 3 + 1, raw = Buffer.alloc(stride * s.height);
    for(let y = 0; y < s.height; y++) for(let x = 0; x < s.width; x++) raw.set(s.pixel(x, y), y * stride + 1 + x * 3);
    const crc = data => { let c = 0xFFFFFFFF; for(const byte of data) { c ^= byte; for(let i = 0; i < 8; i++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (name, data) => { const body = Buffer.concat([Buffer.from(name), data]), b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); body.copy(b, 4); b.writeUInt32BE(crc(body), b.length - 4); return b; };
    const header = Buffer.alloc(13); header.writeUInt32BE(s.width); header.writeUInt32BE(s.height, 4); header[8] = 8; header[9] = 2;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

const start = Date.now();
const elapsed = () => ((Date.now() - start) / 1000).toFixed(0) + " s";
const until = async (condition, what, timeout_ms, poll = 1000) =>
{
    while(!condition())
    {
        assert.ok(Date.now() - start < timeout_ms, "timed out waiting for " + what + "; serial:\n" + plain(serial).slice(-1500));
        await new Promise(resolve => setTimeout(resolve, poll));
    }
};

console.log("Booting " + path.basename(ISO) + " through OVMF (Q35, 2048 MB)");
await until(() => /BdsDxe: starting Boot\d+ "UEFI v86 ATAPI CD-ROM"/.test(plain(serial)), "the boot manager starting the CD", 180000, 200);
console.log("ok - the boot manager starts the CD's loader (" + elapsed() + ")");
// "Press any key to boot from CD or DVD": on the graphics console only
for(let i = 0; i < 8; i++)
{
    emulator.keyboard_send_scancodes([0x1C, 0x9C]);
    await new Promise(resolve => setTimeout(resolve, 700));
}
await until(() => setup_page(screen()), "Windows Setup's first page", 900000, 2000);
console.log("ok - Windows Setup's first page at 1280x800 through GOP (" + elapsed() + ")");
assert.doesNotMatch(plain(serial), /failed to start Boot\d+ "UEFI v86 ATAPI CD-ROM"/);
if(process.env.SHOW_SCREEN) save_png(screen(), process.env.SHOW_SCREEN);

await emulator.destroy();
console.log("PASS");
process.exit(0);
