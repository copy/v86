#!/usr/bin/env node
// Floppy disks written back (docs/disk-persistence-plan.md D3): MS-DOS 6.22
// boots from hda (read_only); fda is a local file, fdb an image of a disk
// service (tools/disk-service.mjs, in this process), both with disk_option
// "read_write" (720 KiB FAT12 disks, images/freedos722.img):
// - a file written to A: and B: is in the file, and the service's image,
//   when the command completes;
// - set_fda inserts another disk written back: the one taken out is
//   flushed and closed; the new one gets the guest's next file; eject
//   closes it;
// - a snapshot holds the floppies' references (no data): restored into a
//   new machine with the same disks;
// - the service gone: the write fails, the guest sees the error (floppy
//   drives report), "disk-error" tells the host;
// - a disk written back that is not of a floppy format's size is refused.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });
const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { create_disk_service } = await import("../../tools/disk-service.mjs");
const ROOT = path.resolve(__dirname, "../..") + "/";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "v86-floppy-"));
for(const name of ["a.img", "a2.img", "b.img"]) fs.copyFileSync(ROOT + "images/freedos722.img", path.join(temp, name));
fs.writeFileSync(path.join(temp, "odd.img"), new Uint8Array(1 << 20));
const service = create_disk_service({ dir: temp, lease_ms: 3000 });
await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + service.server.address().port + "/";
const has = (name, text) => fs.readFileSync(path.join(temp, name)).includes(text);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(options)
{
    const emulator = new V86({
        graphics_adapter: "bochs_vga", bios: { url: ROOT + "bios/seabios.bin" }, vga_bios: { url: ROOT + "bios/vgabios.bin" },
        hda: { url: ROOT + "images/msdos622.img", async: true }, boot_order: 0x312,
        memory_size: 32 << 20, autostart: true, log_level: 0, ...options,
    });
    const events = [];
    emulator.add_listener("disk-error", event => events.push(event));
    await new Promise((resolve, reject) => { emulator.add_listener("emulator-loaded", resolve); emulator.add_listener("emulator-error", reject); });
    return { emulator, events };
}
const screen = emulator => emulator.screen_adapter ? emulator.screen_adapter.get_text_screen().map(l => l.replace(/\x00/g, " ")) : [];
async function until(condition, what, ms = 120000)
{
    const end = Date.now() + ms;
    while(!condition()) { if(Date.now() > end) throw new Error("timeout: " + what); await wait(100); }
}
async function prompt(emulator)
{
    let stable = 0;
    await until(() => { const l = screen(emulator).filter(x => x.trim()); stable = l.length && l[l.length - 1].trim() === "C:\\>" ? stable + 1 : 0; return stable >= 10; }, "C:\\>");
}
async function dos(emulator, command)
{
    await emulator.keyboard_send_text("cls\n", 20);
    await until(() => { const l = screen(emulator).filter(x => x.trim()); return l.length === 1 && l[0].startsWith("C:\\>"); }, "cls");
    await emulator.keyboard_send_text(command + "\n", 20);
    await until(() => screen(emulator).filter(x => x.startsWith("C:\\>")).length >= 2 || screen(emulator).some(l => /Abort, Retry, Fail/.test(l)), command);
    return screen(emulator).join("\n");
}

try
{
    await assert.rejects(start({ fda: { url: path.join(temp, "odd.img"), disk_option: "read_write" } }),
        /fda: a floppy image written back must have the size of a floppy format .* not 1048576/);
    console.log("ok - a floppy written back of no floppy format's size is refused");

    const options = { fda: { url: path.join(temp, "a.img"), disk_option: "read_write" }, fdb: { url: base + "b.img", disk_option: "read_write" } };
    let { emulator } = await start(options);
    await prompt(emulator);
    const fdc = emulator.v86.cpu.devices.fdc;
    const fda = fdc.drives[0].buffer, fdb = fdc.drives[1].buffer;
    assert.ok(fda.writeback && fdb.writeback);
    await dos(emulator, "echo WRITTEN BACK TO A > A:\\A.TXT");
    assert.ok(has("a.img", "WRITTEN BACK TO A"), "A: the file has it when the command completes");
    await dos(emulator, "echo WRITTEN BACK TO B > B:\\B.TXT");
    assert.ok(has("b.img", "WRITTEN BACK TO B"), "B: the service's image has it");
    console.log("ok - A: (a local file) and B: (a disk service) written back: the files are in the images when the commands complete");

    // another disk in A:
    await emulator.set_fda({ url: path.join(temp, "a2.img"), disk_option: "read_write" });
    assert.ok(fda.closed, "the disk taken out: closed");
    await dos(emulator, "dir A: > NUL");
    await dos(emulator, "echo THE SECOND DISK > A:\\SECOND.TXT");
    assert.ok(has("a2.img", "THE SECOND DISK") && !has("a.img", "THE SECOND DISK"), "the new disk has the guest's next file");
    const second = fdc.drives[0].buffer;
    console.log("ok - set_fda: another disk written back; the one taken out is flushed and closed");

    // a snapshot: the references
    const state = await emulator.save_state();
    await emulator.destroy();
    assert.ok(second.closed && fdb.closed, "destroy(): the floppies' disks closed");
    ({ emulator } = await start({ ...options, fda: { url: path.join(temp, "a2.img"), disk_option: "read_write" }, autostart: false }));
    await emulator.restore_state(state);
    await emulator.run();
    const out = await dos(emulator, "type A:\\SECOND.TXT");
    assert.match(out, /THE SECOND DISK/);
    await emulator.eject_fda();
    assert.ok(emulator.v86.cpu.devices.fdc.drives[0].buffer === null);
    await emulator.destroy();
    console.log("ok - a snapshot with the floppies' references restored into a new machine; eject closes the disk");

    // the service gone: the guest sees the error
    const m = await start({ fdb: { url: base + "b.img", disk_option: "read_write" } });
    await prompt(m.emulator);
    const listeners = service.server.listeners("request");
    service.server.removeAllListeners("request");
    service.server.on("request", req => req.socket.destroy());
    const failed = await dos(m.emulator, "echo LOST > B:\\LOST.TXT");
    assert.match(failed, /Abort, Retry, Fail/, "the guest sees the error");
    assert.ok(m.events.length && m.events[0].disk === "fdb" && m.events[0].policy === "report", JSON.stringify(m.events));
    service.server.removeAllListeners("request");
    for(const listener of listeners) service.server.on("request", listener);
    await m.emulator.destroy();
    console.log("ok - the service gone: the floppy's write fails, the guest sees the error, disk-error (report) tells the host");
}
finally
{
    await service.close();
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log("floppy write-back tests passed");
