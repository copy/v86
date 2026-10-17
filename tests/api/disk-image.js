#!/usr/bin/env node

// A guest on a QCOW2 disk (docs/disk-image-formats-plan.md P1): MS-DOS 6.22
// (images/msdos622.img, put in a QCOW2 image of its non-zero clusters,
// tests/image/tiny_qcow2.mjs) boots from it, read in ranges from a file,
// on the IDE disk of i440FX and the AHCI disk of Q35. A file written by the
// guest is there after a restart and after a snapshot restored; the image
// file is never written.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { createHash as create_hash } from "node:crypto";
import { build_qcow2 } from "../image/tiny_qcow2.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const raw = fs.readFileSync(__dirname + "/../../images/msdos622.img");
const CLUSTER = 65536;
const data = [];
for(let offset = 0; offset < raw.length; offset += CLUSTER)
{
    const cluster = raw.subarray(offset, offset + CLUSTER);
    if(cluster.some(b => b)) data.push([offset, new Uint8Array(cluster)]);
}
const image = build_qcow2({ size: raw.length, data });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "v86-disk-image-"));
const image_file = path.join(temp, "msdos622.qcow2");
fs.writeFileSync(image_file, image);
const image_sha256 = create_hash("sha256").update(image).digest("hex");
console.log("msdos622.img (" + raw.length + " bytes) in a QCOW2 image of " + image.length + " bytes");

const lines = emulator => emulator.screen_adapter ? emulator.screen_adapter.get_text_screen().map(line => line.replace(/\x00/g, " ")) : [""];
const screen = emulator => lines(emulator).join("\n");

async function wait_until(emulator, condition, what, timeout = 120000)
{
    const start = Date.now();
    while(!condition())
    {
        if(Date.now() - start > timeout)
        {
            console.error(screen(emulator));
            throw new Error("Timeout waiting for " + what);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

const wait_for = (emulator, pattern, what) => wait_until(emulator, () => pattern.test(screen(emulator)), what);

/** a command at the DOS prompt on a clear screen: its output, once the prompt is back */
async function dos(emulator, command)
{
    // (slowly: the BIOS keyboard buffer has 15 keys)
    await emulator.keyboard_send_text("cls\n", 20);
    // (the prompt has a blank line before it)
    await wait_until(emulator, () => { const l = lines(emulator).filter(x => x.trim()); return l.length === 1 && l[0].startsWith("C:\\>"); }, "cls");
    await emulator.keyboard_send_text(command + "\n", 20);
    await wait_until(emulator, () => lines(emulator).filter(x => x.startsWith("C:\\>")).length >= 2, command);
    return screen(emulator);
}

async function run(machine_type)
{
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        machine_type,
        hda: { url: image_file, async: true, format: "qcow2" },
        network_relay_url: "<UNUSED>",
        autostart: true,
        memory_size: 32 * 1024 * 1024,
        log_level: 0,
        disable_jit: +process.env.DISABLE_JIT,
    });
    emulator.add_listener("emulator-error", error => { throw error; });
    await wait_for(emulator, /C:\\>/, "C:\\> (" + machine_type + ")");
    console.log(machine_type + ": C:\\> from the QCOW2 disk");

    const word = "QCOW" + machine_type.toUpperCase();
    await dos(emulator, "echo " + word + " > C:\\V86TEST.TXT");
    assert.match(await dos(emulator, "type C:\\V86TEST.TXT"), new RegExp("^" + word + "\\s*$", "m"));
    console.log(machine_type + ": the guest wrote a file");

    await emulator.restart();
    await new Promise(resolve => setTimeout(resolve, 2000));
    await wait_for(emulator, /C:\\>/, "C:\\> after the restart");
    assert.match(await dos(emulator, "type C:\\V86TEST.TXT"), new RegExp("^" + word + "\\s*$", "m"));
    console.log(machine_type + ": the file is there after a restart");

    const state = await emulator.save_state();
    await dos(emulator, "echo LATER > C:\\LATER.TXT");
    assert.match(await dos(emulator, "type C:\\LATER.TXT"), /^LATER\s*$/m);
    await emulator.restore_state(state);
    assert.match(await dos(emulator, "dir C:\\LATER.TXT"), /File not found/);
    assert.match(await dos(emulator, "type C:\\V86TEST.TXT"), new RegExp("^" + word + "\\s*$", "m"));
    console.log(machine_type + ": the snapshot restored: the file written after it is gone, the one before is there");

    await emulator.destroy();
    assert.equal(create_hash("sha256").update(fs.readFileSync(image_file)).digest("hex"), image_sha256, "the image file is unchanged");
}

await run("i440fx");
await run("q35");
fs.rmSync(temp, { recursive: true });
console.log("disk image guest tests passed");
