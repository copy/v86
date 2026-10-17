#!/usr/bin/env node
// A guest on each format qemu-img makes (docs/disk-image-formats-plan.md,
// "客体回归"): MS-DOS 6.22 (images/msdos622.img) converted by qemu-img, read in
// ranges from the file, boots, writes a file, finds it after a restart and
// after a snapshot restored; the file is not changed. DISK_IMAGE_GUEST
// selects formats (comma separated names below).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SAMPLES_DIR } from "./samples.mjs";

process.on("unhandledRejection", exn => { throw exn; });

const root = fileURLToPath(new URL("../../", import.meta.url));
const QEMU_IMG = process.env.QEMU_IMG || (fs.existsSync("/opt/homebrew/bin/qemu-img") ? "/opt/homebrew/bin/qemu-img" : "qemu-img");
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

// [name, format option, qemu-img output format, qemu-img options]
const FORMATS = [
    ["qcow2-zlib", "qcow2", "qcow2", ["-c"]],
    ["vhd-dynamic", "vhd", "vpc", []],
    ["vhd-fixed", "vhd", "vpc", ["-o", "subformat=fixed"]],
    ["vdi", "vdi", "vdi", []],
    ["vmdk-sparse", "vmdk", "vmdk", []],
    ["vmdk-stream", "vmdk", "vmdk", ["-o", "subformat=streamOptimized"]],
    // (the streamOptimized VMDK in an OVA, through V86.import_ova)
    ["ova", "vmdk", "vmdk", ["-o", "subformat=streamOptimized"]],
];
const selected = process.env.DISK_IMAGE_GUEST ? process.env.DISK_IMAGE_GUEST.split(",") : FORMATS.map(f => f[0]);

const dir = path.join(SAMPLES_DIR, "guest");
fs.mkdirSync(dir, { recursive: true });
const raw = path.join(root, "images/msdos622.img");

const lines = emulator => emulator.screen_adapter ? emulator.screen_adapter.get_text_screen().map(l => l.replace(/\x00/g, " ")) : [""];
async function until(emulator, condition, what, timeout = 120000)
{
    const start = Date.now();
    while(!condition())
    {
        if(Date.now() - start > timeout)
        {
            console.error(lines(emulator).join("\n"));
            throw new Error("Timeout waiting for " + what);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
/** the prompt, alone on its line, for a second: AUTOEXEC.BAT is done */
async function prompt(emulator, what)
{
    let stable = 0;
    await until(emulator, () =>
    {
        const l = lines(emulator).filter(x => x.trim());
        stable = l.length && l[l.length - 1].trim() === "C:\\>" ? stable + 1 : 0;
        return stable >= 10;
    }, what);
}
async function dos(emulator, command)
{
    await emulator.keyboard_send_text("cls\n", 20);
    await until(emulator, () => { const l = lines(emulator).filter(x => x.trim()); return l.length === 1 && l[0].startsWith("C:\\>"); }, "cls");
    await emulator.keyboard_send_text(command + "\n", 20);
    await until(emulator, () => lines(emulator).filter(x => x.startsWith("C:\\>")).length >= 2, command);
    return lines(emulator).join("\n");
}

for(const [name, format, qemu_format, options] of FORMATS.filter(f => selected.includes(f[0])))
{
    let image = path.join(dir, "msdos622-" + name + "." + qemu_format);
    if(!fs.existsSync(image)) execFileSync(QEMU_IMG, ["convert", "-f", "raw", "-O", qemu_format, ...options, raw, image]);
    let hda = { url: image, async: true, format };
    let machine = { memory_size: 32 << 20 };
    if(name === "ova")
    {
        // an OVF descriptor (64 MiB of memory, one CPU) and the disk in a TAR archive
        fs.writeFileSync(path.join(dir, "dos.ovf"), `<?xml version="1.0"?>
<Envelope xmlns="http://schemas.dmtf.org/ovf/envelope/1" xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1"
    xmlns:rasd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData">
  <References><File ovf:href="msdos622-ova.vmdk" ovf:id="file1"/></References>
  <DiskSection><Disk ovf:capacity="67108864" ovf:diskId="vmdisk1" ovf:fileRef="file1"
      ovf:format="http://www.vmware.com/interfaces/specifications/vmdk.html#streamOptimized"/></DiskSection>
  <VirtualSystem ovf:id="dos"><VirtualHardwareSection>
    <Item><rasd:InstanceID>1</rasd:InstanceID><rasd:ResourceType>3</rasd:ResourceType><rasd:VirtualQuantity>1</rasd:VirtualQuantity></Item>
    <Item><rasd:AllocationUnits>byte * 2^20</rasd:AllocationUnits><rasd:InstanceID>2</rasd:InstanceID><rasd:ResourceType>4</rasd:ResourceType><rasd:VirtualQuantity>64</rasd:VirtualQuantity></Item>
  </VirtualHardwareSection></VirtualSystem>
</Envelope>
`);
        const ova = path.join(dir, "msdos622.ova");
        execFileSync("tar", ["-cf", ova, "--format", "ustar", "-C", dir, "dos.ovf", path.basename(image)]);
        image = ova;
        const imported = await V86.import_ova({ url: ova, async: true });
        assert.equal(imported.options.memory_size, 64 << 20);
        hda = imported.options.hda;
        machine = { memory_size: imported.options.memory_size, cpu_cores: imported.options.cpu_cores };
    }
    const sha256 = create_hash("sha256").update(fs.readFileSync(image)).digest("hex");
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        bios: { url: root + "bios/seabios.bin" }, vga_bios: { url: root + "bios/vgabios.bin" },
        hda, ...machine,
        autostart: true, log_level: 0,
    });
    emulator.add_listener("emulator-error", error => { throw error; });
    await prompt(emulator, "C:\\>");
    const word = "V86" + name.replace(/-/g, "").toUpperCase().slice(0, 8);
    await dos(emulator, "echo " + word + " > C:\\FORMAT.TXT");
    assert.match(await dos(emulator, "type C:\\FORMAT.TXT"), new RegExp("^" + word + "\\s*$", "m"));
    await emulator.restart();
    await new Promise(resolve => setTimeout(resolve, 2000));
    await prompt(emulator, "C:\\> after the restart");
    assert.match(await dos(emulator, "type C:\\FORMAT.TXT"), new RegExp("^" + word + "\\s*$", "m"));
    const state = await emulator.save_state();
    await dos(emulator, "del C:\\FORMAT.TXT");
    await emulator.restore_state(state);
    assert.match(await dos(emulator, "type C:\\FORMAT.TXT"), new RegExp("^" + word + "\\s*$", "m"));
    await emulator.destroy();
    assert.equal(create_hash("sha256").update(fs.readFileSync(image)).digest("hex"), sha256, "the image file is unchanged");
    console.log("ok - " + name + ": MS-DOS boots, writes a file, finds it after a restart and after a snapshot restored");
}
console.log("guest tests passed");
